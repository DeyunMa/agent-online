import type { AgentRuntimeId } from "../agent/contract";
import { defaultAgentRuntimeId } from "../agent/registry";
import { CreateAgentRunService } from "../application/create-agent-run";
import { ProjectChangesService } from "../application/project-changes";
import { ProjectFilesService } from "../application/project-files";
import { ProjectManagementService } from "../application/project-management";
import { ProjectPreviewService } from "../application/project-preview";
import { ProjectReadService } from "../application/project-read";
import {
  ProjectSandboxService,
  type StopProjectSandboxResult,
} from "../application/project-sandbox";
import { SandboxReclaimer } from "../application/sandbox-reclaimer";
import { ProjectTerminalService } from "../application/project-terminal";
import type { RuntimeKind, SandboxRuntime } from "../runtime/contract";
import type { DiagnosticContext, DiagnosticReporter } from "../observability/contract";
import type { E2BSandboxRuntime } from "../runtime/e2b-runtime";
import { FakeSandboxRuntime } from "../runtime/fake-runtime";
import { createE2BSandboxRuntime } from "./e2b-runtime-factory";
import { getAgentRuntimePolicy } from "./agent-runtime-policy";
import type { AppBindings } from "./env";
import {
  D1AgentRunRepository,
  D1MessageRepository,
  D1PreviewSessionRepository,
  D1ProjectRepository,
  D1SandboxLeaseRepository,
  D1TerminalSessionRepository,
} from "./persistence/d1-repositories";
import { createPreviewCapabilityCodec, previewContentBasePath } from "./preview-capability";
import {
  defaultWorkingDirectory,
  getDefaultModelId,
  getInstalledSandboxRuntimeId,
} from "./runtime-config";
import {
  createInlineFakeDispatcher,
  createWorkflowDispatcher,
  type RunExecutionDispatcher,
  schedulePreviewExpiry,
  schedulePreviewIdleCleanupBestEffort,
  scheduleTerminalExpiry,
  scheduleTerminalIdleCleanupBestEffort,
} from "./run-execution-dispatcher";
import { createDiagnosticReporter } from "./observability/reporter";

export type { RunExecutionDispatcher } from "./run-execution-dispatcher";

export interface ProjectSandboxController {
  stop(projectId: string): Promise<StopProjectSandboxResult>;
}

export type ServerServices = {
  createAgentRuns: CreateAgentRunService;
  diagnostics: DiagnosticReporter;
  enabledAgentRuntimeIds: readonly AgentRuntimeId[];
  projectChanges: ProjectChangesService;
  projectFiles: ProjectFilesService;
  projectManagement: ProjectManagementService;
  projectPreviews: ProjectPreviewService;
  projectReads: ProjectReadService;
  projectSandboxes: ProjectSandboxController;
  projectTerminals: ProjectTerminalService;
  runExecutions: RunExecutionDispatcher;
};

export function createServerServices(
  env: AppBindings,
  diagnosticContext: DiagnosticContext = {},
): ServerServices {
  const diagnostics = createDiagnosticReporter(diagnosticContext);
  const agentRuns = new D1AgentRunRepository(env.DB);
  const messages = new D1MessageRepository(env.DB);
  const projects = new D1ProjectRepository(env.DB);
  const sandboxLeases = new D1SandboxLeaseRepository(env.DB);
  const previewSessions = new D1PreviewSessionRepository(env.DB);
  const terminalSessions = new D1TerminalSessionRepository(env.DB);
  const sandboxRuntimeId = getInstalledSandboxRuntimeId(env);
  const agentRuntimePolicy = getAgentRuntimePolicy(env, sandboxRuntimeId);
  const fakeRuntime =
    sandboxRuntimeId === "fake" ? new FakeSandboxRuntime({ completionDelayMs: 8_000 }) : null;
  let e2bRuntime: E2BSandboxRuntime | null = null;
  const getSandboxRuntime = (id: RuntimeKind) => {
    if (id !== sandboxRuntimeId) {
      throw new Error(`Sandbox runtime is not installed: ${id}`);
    }

    if (fakeRuntime) {
      return requireRuntime(fakeRuntime, id);
    }

    e2bRuntime ??= createE2BSandboxRuntime(env).runtime;
    return requireRuntime(e2bRuntime, id);
  };
  const getTerminalRuntime = (id: RuntimeKind) => {
    if (id !== sandboxRuntimeId || id !== "e2b") {
      return null;
    }

    e2bRuntime ??= createE2BSandboxRuntime(env).runtime;
    return e2bRuntime;
  };
  const getChangesRuntime = (id: RuntimeKind) => {
    if (id !== sandboxRuntimeId || id !== "e2b") {
      return null;
    }

    e2bRuntime ??= createE2BSandboxRuntime(env).runtime;
    return e2bRuntime;
  };
  const runExecutions =
    sandboxRuntimeId === "fake"
      ? createInlineFakeDispatcher(
          agentRuns,
          sandboxLeases,
          getSandboxRuntime("fake"),
          agentRuntimePolicy.resolve,
          diagnostics,
        )
      : createWorkflowDispatcher(env, diagnosticContext);
  const sandboxReclaimer = new SandboxReclaimer({
    agentRuns,
    clock: { now: () => new Date() },
    diagnostics,
    getSandboxRuntime,
    sandboxLeases,
  });
  const projectSandboxes = new ProjectSandboxService({
    agentRuns,
    previewSessions,
    sandboxReclaimer,
    sandboxLeases,
    terminalSessions,
  });

  return {
    createAgentRuns: new CreateAgentRunService({
      agentRuns,
      clock: { now: () => new Date() },
      createId: () => crypto.randomUUID(),
      defaultModelId: getDefaultModelId(env),
      diagnostics,
      runExecutions,
      sandboxLeases,
      sandboxRuntimeId,
      workingDirectory: defaultWorkingDirectory,
    }),
    diagnostics,
    enabledAgentRuntimeIds: agentRuntimePolicy.executionRuntimeIds,
    projectChanges: new ProjectChangesService({
      agentRuns,
      getSandboxRuntime: getChangesRuntime,
      sandboxLeases,
      terminalSessions,
    }),
    projectFiles: new ProjectFilesService({
      agentRuns,
      getSandboxRuntime,
      now: () => new Date(),
      sandboxLeases,
      terminalSessions,
      workingDirectory: defaultWorkingDirectory,
    }),
    projectManagement: new ProjectManagementService({
      createId: () => crypto.randomUUID(),
      defaultAgentRuntimeId,
      now: () => new Date(),
      projects,
      projectSandboxes,
    }),
    projectPreviews: new ProjectPreviewService({
      agentRuns,
      clock: { now: () => new Date() },
      createContentBasePath: (input) => createPreviewContentBasePath(env, input),
      createId: () => crypto.randomUUID(),
      getSandboxRuntime: getTerminalRuntime,
      previewSessions,
      reportFailure: () => {
        diagnostics.report({
          errorCode: "PREVIEW_START_FAILED",
          event: "project_preview.failed",
          outcome: "failed",
          stage: "preview_start",
        });
      },
      sandboxLeases,
      sandboxRuntimeId,
      scheduleExpiry:
        sandboxRuntimeId === "e2b"
          ? (input) => schedulePreviewExpiry(env, input)
          : async () => undefined,
      scheduleIdleCleanup:
        sandboxRuntimeId === "e2b"
          ? (input) => schedulePreviewIdleCleanupBestEffort(env, input)
          : async () => undefined,
      terminalSessions,
    }),
    projectReads: new ProjectReadService({
      agentRuns,
      messages,
      projects,
      sandboxLeases,
    }),
    projectSandboxes,
    projectTerminals: new ProjectTerminalService({
      agentRuns,
      clock: { now: () => new Date() },
      createId: () => crypto.randomUUID(),
      getSandboxRuntime: getTerminalRuntime,
      sandboxLeases,
      sandboxRuntimeId,
      scheduleIdleCleanup:
        sandboxRuntimeId === "e2b"
          ? (input) => scheduleTerminalIdleCleanupBestEffort(env, input)
          : async () => undefined,
      scheduleExpiry:
        sandboxRuntimeId === "e2b"
          ? (input) => scheduleTerminalExpiry(env, input)
          : async () => undefined,
      terminalSessions,
      workingDirectory: defaultWorkingDirectory,
    }),
    runExecutions,
  };
}

export function createProjectPreviewService(env: AppBindings) {
  const sandboxRuntimeId = getInstalledSandboxRuntimeId(env);
  const previewSessions = new D1PreviewSessionRepository(env.DB);
  const sandboxLeases = new D1SandboxLeaseRepository(env.DB);
  const runtime = sandboxRuntimeId === "e2b" ? createE2BSandboxRuntime(env).runtime : null;

  return new ProjectPreviewService({
    agentRuns: new D1AgentRunRepository(env.DB),
    clock: { now: () => new Date() },
    createContentBasePath: (input) => createPreviewContentBasePath(env, input),
    createId: () => crypto.randomUUID(),
    getSandboxRuntime(id) {
      if (id !== "e2b" || runtime?.kind !== id) {
        return null;
      }
      return runtime;
    },
    previewSessions,
    sandboxLeases,
    sandboxRuntimeId,
    scheduleExpiry: (input) => schedulePreviewExpiry(env, input),
    scheduleIdleCleanup: (input) => schedulePreviewIdleCleanupBestEffort(env, input),
    terminalSessions: new D1TerminalSessionRepository(env.DB),
  });
}

export function createProjectTerminalService(env: AppBindings) {
  const sandboxRuntimeId = getInstalledSandboxRuntimeId(env);
  const terminalSessions = new D1TerminalSessionRepository(env.DB);
  const sandboxLeases = new D1SandboxLeaseRepository(env.DB);
  const runtime = sandboxRuntimeId === "e2b" ? createE2BSandboxRuntime(env).runtime : null;

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
    scheduleIdleCleanup: (input) => scheduleTerminalIdleCleanupBestEffort(env, input),
    terminalSessions,
    workingDirectory: defaultWorkingDirectory,
  });
}

function requireRuntime(runtime: SandboxRuntime, id: RuntimeKind) {
  if (runtime.kind !== id) {
    throw new Error(`Sandbox runtime is not installed: ${id}`);
  }

  return runtime;
}

async function createPreviewContentBasePath(
  env: AppBindings,
  input: {
    expiresAt: string;
    issuedAt: string;
    previewSessionId: string;
    projectId: string;
  },
) {
  if (!env.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET is required");
  }
  const issuedAt = new Date(input.issuedAt);
  const token = await createPreviewCapabilityCodec({
    now: () => issuedAt,
    secret: env.BETTER_AUTH_SECRET,
  }).issue({
    expiresAt: new Date(input.expiresAt),
    issuedAt,
    previewSessionId: input.previewSessionId,
    projectId: input.projectId,
  });

  return previewContentBasePath(input.projectId, token);
}
