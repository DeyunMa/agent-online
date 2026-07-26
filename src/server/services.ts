import { getAgentRuntime } from "../agent/registry";
import type {
  AgentRunRecord,
  AgentRunRepository,
  MessageRepository,
  ProjectRepository,
  SandboxLeaseRepository,
} from "../application/ports";
import {
  ProjectFilesService,
} from "../application/project-files";
import {
  ProjectSandboxService,
  type StopProjectSandboxResult,
} from "../application/project-sandbox";
import {
  RunCoordinator,
  type StartAgentRunInput,
} from "../application/run-coordinator";
import { isTerminalAgentRun } from "../domain/agent-run";
import type { RuntimeKind, SandboxRuntime } from "../runtime/contract";
import { FakeSandboxRuntime } from "../runtime/fake-runtime";
import { createE2BRunExecution } from "./e2b-run-execution";
import type { AppBindings } from "./env";
import {
  D1AgentRunRepository,
  D1MessageRepository,
  D1ProjectRepository,
  D1SandboxLeaseRepository,
} from "./persistence/d1-repositories";
import {
  defaultWorkingDirectory,
  getDefaultModelId,
  getE2BExecutionConfig,
  getInstalledSandboxRuntimeId,
  type InstalledSandboxRuntimeId,
} from "./runtime-config";

export type RunExecutionStartResult = {
  completion: Promise<AgentRunRecord> | null;
};

export interface RunExecutionDispatcher {
  cancel(run: AgentRunRecord, now: Date): Promise<AgentRunRecord | null>;
  start(input: StartAgentRunInput): Promise<RunExecutionStartResult>;
}

export interface ProjectSandboxController {
  stop(projectId: string): Promise<StopProjectSandboxResult>;
}

export type ServerServices = {
  agentRuns: AgentRunRepository;
  defaultModelId: string;
  messages: MessageRepository;
  projectFiles: ProjectFilesService;
  projectSandboxes: ProjectSandboxController;
  projects: ProjectRepository;
  runExecutions: RunExecutionDispatcher;
  sandboxRuntimeId: InstalledSandboxRuntimeId;
  sandboxLeases: SandboxLeaseRepository;
};

export function createServerServices(env: AppBindings): ServerServices {
  const agentRuns = new D1AgentRunRepository(env.DB);
  const messages = new D1MessageRepository(env.DB);
  const sandboxLeases = new D1SandboxLeaseRepository(env.DB);
  const sandboxRuntimeId = getInstalledSandboxRuntimeId(env);
  const fakeRuntime =
    sandboxRuntimeId === "fake"
      ? new FakeSandboxRuntime({ completionDelayMs: 8_000 })
      : null;
  let e2bRuntime: SandboxRuntime | null = null;
  const getSandboxRuntime = (id: RuntimeKind) => {
    if (id !== sandboxRuntimeId) {
      throw new Error(`Sandbox runtime is not installed: ${id}`);
    }

    if (fakeRuntime) {
      return requireRuntime(fakeRuntime, id);
    }

    e2bRuntime ??= createE2BRunExecution(env).runtime;
    return requireRuntime(e2bRuntime, id);
  };
  const runExecutions =
    sandboxRuntimeId === "fake"
      ? createInlineFakeDispatcher(
          agentRuns,
          messages,
          sandboxLeases,
          getSandboxRuntime("fake"),
        )
      : createWorkflowDispatcher(env);

  return {
    agentRuns,
    defaultModelId: getDefaultModelId(env),
    messages,
    projectFiles: new ProjectFilesService({
      agentRuns,
      getSandboxRuntime,
      sandboxLeases,
      workingDirectory: defaultWorkingDirectory,
    }),
    projectSandboxes: new ProjectSandboxService({
      agentRuns,
      getSandboxRuntime,
      now: () => new Date(),
      sandboxLeases,
    }),
    projects: new D1ProjectRepository(env.DB),
    runExecutions,
    sandboxRuntimeId,
    sandboxLeases,
  };
}

function createInlineFakeDispatcher(
  agentRuns: AgentRunRepository,
  messages: MessageRepository,
  sandboxLeases: SandboxLeaseRepository,
  runtime: SandboxRuntime,
): RunExecutionDispatcher {
  const coordinator = new RunCoordinator({
    agentRunRepository: agentRuns,
    clock: { now: () => new Date() },
    createId: () => crypto.randomUUID(),
    getAgentRuntime,
    getSandboxRuntime(id) {
      return requireRuntime(runtime, id);
    },
    messageRepository: messages,
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

function createWorkflowDispatcher(
  env: AppBindings,
): RunExecutionDispatcher {
  return {
    async cancel(run) {
      const cancelled = await createE2BRunExecution(env).service.cancel({
        projectId: run.projectId,
        runId: run.id,
      });
      await terminateWorkflowBestEffort(env, run.id);
      await scheduleIdleCleanupBestEffort(env, run.projectId, run.id);
      return cancelled;
    },
    async start(input) {
      getE2BExecutionConfig(env);
      await createWorkflowInstance(env, {
        id: input.agentRun.id,
        kind: "execute",
        projectId: input.agentRun.projectId,
        runId: input.agentRun.id,
      });
      return { completion: null };
    },
  };
}

async function createWorkflowInstance(
  env: AppBindings,
  input: {
    id: string;
    kind: "execute" | "idle-cleanup";
    projectId: string;
    runId: string;
  },
) {
  await env.AGENT_RUN_WORKFLOW.create({
    id: input.id,
    params: {
      kind: input.kind,
      projectId: input.projectId,
      runId: input.runId,
    },
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

async function scheduleIdleCleanupBestEffort(
  env: AppBindings,
  projectId: string,
  runId: string,
) {
  try {
    await createWorkflowInstance(env, {
      id: `idle-${runId}`,
      kind: "idle-cleanup",
      projectId,
      runId,
    });
  } catch (_error) {
    // E2B's own timeout remains the final cleanup bound.
  }
}

function requireRuntime(runtime: SandboxRuntime, id: RuntimeKind) {
  if (runtime.kind !== id) {
    throw new Error(`Sandbox runtime is not installed: ${id}`);
  }

  return runtime;
}
