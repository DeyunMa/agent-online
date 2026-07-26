import type { AgentRuntime, AgentRuntimeId } from "../agent/contract";
import type {
  AgentRunRecord,
  AgentRunRepository,
  MessageRepository,
  ProjectRepository,
  SandboxLeaseRepository,
} from "../application/ports";
import {
  CreateAgentRunService,
  type AgentRunExecutionStarter,
} from "../application/create-agent-run";
import { ProjectFilesService } from "../application/project-files";
import {
  ProjectSandboxService,
  type StopProjectSandboxResult,
} from "../application/project-sandbox";
import { ProjectTerminalService } from "../application/project-terminal";
import { RunCoordinator } from "../application/run-coordinator";
import { isTerminalAgentRun } from "../domain/agent-run";
import type { RuntimeKind, SandboxRuntime } from "../runtime/contract";
import type { E2BSandboxRuntime } from "../runtime/e2b-runtime";
import { FakeSandboxRuntime } from "../runtime/fake-runtime";
import { createE2BRunExecution } from "./e2b-run-execution";
import { getAgentRuntimePolicy } from "./agent-runtime-policy";
import type {
  AgentRunWorkflowPayload,
  AppBindings,
} from "./env";
import {
  D1AgentRunRepository,
  D1MessageRepository,
  D1ProjectRepository,
  D1SandboxLeaseRepository,
  D1TerminalSessionRepository,
} from "./persistence/d1-repositories";
import {
  defaultWorkingDirectory,
  getDefaultModelId,
  getE2BExecutionConfig,
  getInstalledSandboxRuntimeId,
  type InstalledSandboxRuntimeId,
} from "./runtime-config";

export interface RunExecutionDispatcher
  extends AgentRunExecutionStarter {
  cancel(run: AgentRunRecord, now: Date): Promise<AgentRunRecord | null>;
}

export interface ProjectSandboxController {
  stop(projectId: string): Promise<StopProjectSandboxResult>;
}

export type ServerServices = {
  agentRuns: AgentRunRepository;
  createAgentRuns: CreateAgentRunService;
  defaultModelId: string;
  enabledAgentRuntimeIds: readonly AgentRuntimeId[];
  messages: MessageRepository;
  projectFiles: ProjectFilesService;
  projectSandboxes: ProjectSandboxController;
  projectTerminals: ProjectTerminalService;
  projects: ProjectRepository;
  runExecutions: RunExecutionDispatcher;
  sandboxRuntimeId: InstalledSandboxRuntimeId;
  sandboxLeases: SandboxLeaseRepository;
};

export function createServerServices(env: AppBindings): ServerServices {
  const agentRuns = new D1AgentRunRepository(env.DB);
  const messages = new D1MessageRepository(env.DB);
  const sandboxLeases = new D1SandboxLeaseRepository(env.DB);
  const terminalSessions = new D1TerminalSessionRepository(env.DB);
  const sandboxRuntimeId = getInstalledSandboxRuntimeId(env);
  const agentRuntimePolicy = getAgentRuntimePolicy(env, sandboxRuntimeId);
  const fakeRuntime =
    sandboxRuntimeId === "fake"
      ? new FakeSandboxRuntime({ completionDelayMs: 8_000 })
      : null;
  let e2bRuntime: E2BSandboxRuntime | null = null;
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
  const getTerminalRuntime = (id: RuntimeKind) => {
    if (id !== sandboxRuntimeId || id !== "e2b") {
      return null;
    }

    e2bRuntime ??= createE2BRunExecution(env).runtime;
    return e2bRuntime;
  };
  const runExecutions =
    sandboxRuntimeId === "fake"
      ? createInlineFakeDispatcher(
          agentRuns,
          messages,
          sandboxLeases,
          getSandboxRuntime("fake"),
          agentRuntimePolicy.resolve,
        )
      : createWorkflowDispatcher(env);

  return {
    agentRuns,
    createAgentRuns: new CreateAgentRunService({
      agentRuns,
      clock: { now: () => new Date() },
      createId: () => crypto.randomUUID(),
      defaultModelId: getDefaultModelId(env),
      runExecutions,
      sandboxLeases,
      sandboxRuntimeId,
      workingDirectory: defaultWorkingDirectory,
    }),
    defaultModelId: getDefaultModelId(env),
    enabledAgentRuntimeIds: agentRuntimePolicy.executionRuntimeIds,
    messages,
    projectFiles: new ProjectFilesService({
      agentRuns,
      getSandboxRuntime,
      now: () => new Date(),
      sandboxLeases,
      terminalSessions,
      workingDirectory: defaultWorkingDirectory,
    }),
    projectSandboxes: new ProjectSandboxService({
      agentRuns,
      getSandboxRuntime,
      now: () => new Date(),
      sandboxLeases,
      terminalSessions,
    }),
    projectTerminals: new ProjectTerminalService({
      agentRuns,
      clock: { now: () => new Date() },
      createId: () => crypto.randomUUID(),
      getSandboxRuntime: getTerminalRuntime,
      sandboxLeases,
      sandboxRuntimeId,
      scheduleIdleCleanup:
        sandboxRuntimeId === "e2b"
          ? (input) =>
              scheduleTerminalIdleCleanupBestEffort(env, input)
          : async () => undefined,
      scheduleExpiry:
        sandboxRuntimeId === "e2b"
          ? (input) => scheduleTerminalExpiry(env, input)
          : async () => undefined,
      terminalSessions,
      workingDirectory: defaultWorkingDirectory,
    }),
    projects: new D1ProjectRepository(env.DB),
    runExecutions,
    sandboxRuntimeId,
    sandboxLeases,
  };
}

export function createProjectTerminalService(env: AppBindings) {
  const sandboxRuntimeId = getInstalledSandboxRuntimeId(env);
  const terminalSessions = new D1TerminalSessionRepository(env.DB);
  const sandboxLeases = new D1SandboxLeaseRepository(env.DB);
  const runtime =
    sandboxRuntimeId === "e2b"
      ? createE2BRunExecution(env).runtime
      : null;

  return new ProjectTerminalService({
    agentRuns: new D1AgentRunRepository(env.DB),
    clock: { now: () => new Date() },
    createId: () => crypto.randomUUID(),
    getSandboxRuntime(id) {
      if (id !== "e2b" || runtime?.kind !== id) {
        return null;
      }
      return runtime;
    },
    sandboxLeases,
    sandboxRuntimeId,
    scheduleExpiry: (input) => scheduleTerminalExpiry(env, input),
    scheduleIdleCleanup: (input) =>
      scheduleTerminalIdleCleanupBestEffort(env, input),
    terminalSessions,
    workingDirectory: defaultWorkingDirectory,
  });
}

function createInlineFakeDispatcher(
  agentRuns: AgentRunRepository,
  messages: MessageRepository,
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

async function scheduleIdleCleanupBestEffort(
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

async function scheduleTerminalIdleCleanupBestEffort(
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

async function scheduleTerminalExpiry(
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

function requireRuntime(runtime: SandboxRuntime, id: RuntimeKind) {
  if (runtime.kind !== id) {
    throw new Error(`Sandbox runtime is not installed: ${id}`);
  }

  return runtime;
}
