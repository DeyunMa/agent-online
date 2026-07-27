import type { AgentRuntime, AgentRuntimeId } from "../agent/contract";
import type {
  AgentRunRecord,
  AgentRunRepository,
  SandboxLeaseRepository,
} from "../application/ports";
import type { AgentRunExecutionStarter } from "../application/create-agent-run";
import { RunCoordinator } from "../application/run-coordinator";
import { isTerminalAgentRun } from "../domain/agent-run";
import type { SandboxRuntime } from "../runtime/contract";
import { createE2BRunExecution } from "./e2b-run-execution";
import type { AgentRunWorkflowPayload, AppBindings } from "./env";
import { getE2BExecutionConfig } from "./runtime-config";

export interface RunExecutionDispatcher extends AgentRunExecutionStarter {
  cancel(run: AgentRunRecord, now: Date): Promise<AgentRunRecord | null>;
}

export function createInlineFakeDispatcher(
  agentRuns: AgentRunRepository,
  sandboxLeases: SandboxLeaseRepository,
  runtime: SandboxRuntime,
  getAgentRuntime: (id: AgentRuntimeId) => AgentRuntime,
): RunExecutionDispatcher {
  const coordinator = new RunCoordinator({
    agentRunRepository: agentRuns,
    clock: { now: () => new Date() },
    createId: () => crypto.randomUUID(),
    getAgentRuntime,
    getSandboxRuntime(id) {
      if (runtime.kind !== id) {
        throw new Error(`Sandbox runtime is not installed: ${id}`);
      }
      return runtime;
    },
    sandboxLeaseRepository: sandboxLeases,
  });

  return {
    async cancel(run, now) {
      if (isTerminalAgentRun(run.status) || run.status === "cancelling") {
        return run;
      }

      const targetStatus = run.status === "queued" ? "cancelled" : "cancelling";
      const updatedRun = await agentRuns.transition({
        finishedAt: targetStatus === "cancelled" ? now.toISOString() : undefined,
        from: run.status,
        runId: run.id,
        to: targetStatus,
      });
      return updatedRun ?? agentRuns.findById(run.id);
    },
    async start(input) {
      const coordinatedRun = await coordinator.start(input);
      return { completion: coordinatedRun.completion };
    },
  };
}

export function createWorkflowDispatcher(env: AppBindings): RunExecutionDispatcher {
  return {
    async cancel(run) {
      const cancelled = await createE2BRunExecution(env).service.cancel({
        projectId: run.projectId,
        runId: run.id,
      });
      await terminateWorkflowBestEffort(env, run.id);
      await scheduleRunIdleCleanupBestEffort(env, run.projectId, run.id);
      return cancelled;
    },
    async start(input) {
      getE2BExecutionConfig(env);
      await createWorkflowInstance(env, {
        id: input.agentRun.id,
        payload: {
          kind: "execute",
          projectId: input.agentRun.projectId,
          runId: input.agentRun.id,
        },
      });
      return { completion: null };
    },
  };
}

export async function scheduleRunIdleCleanupBestEffort(
  env: AppBindings,
  projectId: string,
  runId: string,
) {
  try {
    await createWorkflowInstance(env, {
      id: `idle-${runId}`,
      payload: {
        kind: "idle-cleanup",
        projectId,
        runId,
      },
    });
  } catch (_error) {
    // E2B's own timeout remains the final cleanup bound.
  }
}

export async function scheduleTerminalIdleCleanupBestEffort(
  env: AppBindings,
  input: {
    expectedLeaseUpdatedAt: string;
    projectId: string;
    terminalSessionId: string;
  },
) {
  try {
    await createWorkflowInstance(env, {
      id: `terminal-idle-${input.terminalSessionId}`,
      payload: {
        expectedLeaseUpdatedAt: input.expectedLeaseUpdatedAt,
        kind: "terminal-idle-cleanup",
        projectId: input.projectId,
        terminalSessionId: input.terminalSessionId,
      },
    });
  } catch {
    // E2B's own sandbox timeout remains the final cleanup bound.
  }
}

export async function scheduleTerminalExpiry(
  env: AppBindings,
  input: {
    expiresAt: string;
    projectId: string;
    terminalSessionId: string;
  },
) {
  await createWorkflowInstance(env, {
    id: `terminal-expiry-${input.terminalSessionId}`,
    payload: {
      expiresAt: input.expiresAt,
      kind: "terminal-expiry",
      projectId: input.projectId,
      terminalSessionId: input.terminalSessionId,
    },
  });
}

export async function schedulePreviewIdleCleanupBestEffort(
  env: AppBindings,
  input: {
    expectedLeaseUpdatedAt: string;
    previewSessionId: string;
    projectId: string;
  },
) {
  try {
    await createWorkflowInstance(env, {
      id: `preview-idle-${input.previewSessionId}`,
      payload: {
        expectedLeaseUpdatedAt: input.expectedLeaseUpdatedAt,
        kind: "preview-idle-cleanup",
        previewSessionId: input.previewSessionId,
        projectId: input.projectId,
      },
    });
  } catch {
    // E2B's own sandbox timeout remains the final cleanup bound.
  }
}

export async function schedulePreviewExpiry(
  env: AppBindings,
  input: {
    expiresAt: string;
    previewSessionId: string;
    projectId: string;
  },
) {
  await createWorkflowInstance(env, {
    id: `preview-expiry-${input.previewSessionId}`,
    payload: {
      expiresAt: input.expiresAt,
      kind: "preview-expiry",
      previewSessionId: input.previewSessionId,
      projectId: input.projectId,
    },
  });
}

async function createWorkflowInstance(
  env: AppBindings,
  input: {
    id: string;
    payload: AgentRunWorkflowPayload;
  },
) {
  await env.AGENT_RUN_WORKFLOW.create({
    id: input.id,
    params: input.payload,
    retention: {
      errorRetention: "1 day",
      successRetention: "1 day",
    },
  });
}

async function terminateWorkflowBestEffort(env: AppBindings, runId: string) {
  try {
    const instance = await env.AGENT_RUN_WORKFLOW.get(runId);
    const status = await instance.status();
    if (
      status.status === "queued" ||
      status.status === "running" ||
      status.status === "paused" ||
      status.status === "waiting" ||
      status.status === "waitingForPause"
    ) {
      await instance.terminate();
    }
  } catch (_error) {
    // Provider process cancellation and D1 convergence remain authoritative.
  }
}
