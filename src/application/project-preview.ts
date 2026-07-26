import {
  SandboxUnavailableError,
  type RuntimeHandle,
  type RuntimeKind,
  type SandboxPreviewRequest,
  type SandboxPreviewRuntime,
} from "../runtime/contract";
import type {
  AgentRunRepository,
  PreviewSessionRecord,
  PreviewSessionRepository,
  SandboxLeaseRepository,
  TerminalSessionRepository,
} from "./ports";

export const projectPreviewPort = 3000;
export const defaultPreviewSessionDurationMs = 30 * 60 * 1_000;
export const defaultPreviewStartupTimeoutMs = 20 * 1_000;

export type ProjectPreviewStatus =
  | { expiresAt: null; kind: "stopped" }
  | {
      expiresAt: string;
      issuedAt: string;
      kind: "running";
      sessionId: string;
    }
  | {
      expiresAt: string;
      issuedAt: string;
      kind: "starting";
      sessionId: string;
    };

export type StartProjectPreviewResult =
  | { kind: "project_busy" }
  | { kind: "provider_error" }
  | { kind: "runtime_mismatch" }
  | { kind: "sandbox_unavailable" }
  | {
      kind: "started";
      status: Extract<ProjectPreviewStatus, { kind: "running" }>;
    };

export type StopProjectPreviewResult =
  | { kind: "project_busy" }
  | { kind: "provider_error" }
  | { kind: "stopped" };

export type InspectProjectPreviewResult =
  | ProjectPreviewStatus
  | { kind: "provider_error" }
  | { kind: "runtime_mismatch" };

export type FetchProjectPreviewResult =
  | { kind: "not_found" }
  | { kind: "provider_error" }
  | { kind: "runtime_mismatch" }
  | { kind: "sandbox_unavailable" }
  | { kind: "ok"; response: Response };

export type ProjectPreviewServiceOptions = {
  agentRuns: Pick<AgentRunRepository, "findActiveByProjectId">;
  clock: { now(): Date };
  createContentBasePath(input: {
    expiresAt: string;
    issuedAt: string;
    previewSessionId: string;
    projectId: string;
  }): Promise<string>;
  createId(): string;
  getSandboxRuntime(id: RuntimeKind): SandboxPreviewRuntime | null;
  previewSessions: PreviewSessionRepository;
  sandboxLeases: Pick<SandboxLeaseRepository, "findByProjectId">;
  sandboxRuntimeId: RuntimeKind;
  scheduleExpiry(input: {
    expiresAt: string;
    previewSessionId: string;
    projectId: string;
  }): Promise<void>;
  scheduleIdleCleanup(input: {
    expectedLeaseUpdatedAt: string;
    previewSessionId: string;
    projectId: string;
  }): Promise<void>;
  sessionDurationMs?: number;
  startupTimeoutMs?: number;
  terminalSessions: Pick<TerminalSessionRepository, "findByProjectId">;
};

/**
 * Owns one current Project preview process. D1 stores only transient process
 * ownership; provider hosts and traffic credentials stay inside the runtime.
 */
export class ProjectPreviewService {
  private readonly sessionDurationMs: number;
  private readonly startupTimeoutMs: number;

  constructor(private readonly options: ProjectPreviewServiceOptions) {
    this.sessionDurationMs =
      options.sessionDurationMs ?? defaultPreviewSessionDurationMs;
    this.startupTimeoutMs =
      options.startupTimeoutMs ?? defaultPreviewStartupTimeoutMs;
    requirePositiveDuration(this.sessionDurationMs, "Preview session duration");
    requirePositiveDuration(this.startupTimeoutMs, "Preview startup timeout");
  }

  async start(projectId: string): Promise<StartProjectPreviewResult> {
    const current = await this.options.previewSessions.findByProjectId(
      projectId,
    );
    if (current) {
      return { kind: "project_busy" };
    }
    if (await this.options.agentRuns.findActiveByProjectId(projectId)) {
      return { kind: "project_busy" };
    }
    if (await this.options.terminalSessions.findByProjectId(projectId)) {
      return { kind: "project_busy" };
    }

    const lease = await this.options.sandboxLeases.findByProjectId(projectId);
    if (
      !lease?.providerRef ||
      (lease.status !== "idle" && lease.status !== "ready")
    ) {
      return { kind: "sandbox_unavailable" };
    }
    if (lease.runtimeId !== this.options.sandboxRuntimeId) {
      return { kind: "runtime_mismatch" };
    }

    let runtime: SandboxPreviewRuntime | null;
    try {
      runtime = this.options.getSandboxRuntime(lease.runtimeId);
    } catch {
      return { kind: "provider_error" };
    }
    if (!runtime) {
      return { kind: "sandbox_unavailable" };
    }

    const now = this.options.clock.now();
    const claimed = await this.options.previewSessions.claim({
      expectedLeaseProviderRef: lease.providerRef,
      expectedLeaseUpdatedAt: lease.updatedAt,
      expiresAt: new Date(
        now.getTime() + this.sessionDurationMs,
      ).toISOString(),
      id: this.options.createId(),
      now: now.toISOString(),
      port: projectPreviewPort,
      projectId,
      sandboxLeaseId: lease.id,
    });
    if (claimed.kind === "project_busy") {
      return claimed;
    }

    try {
      await this.options.scheduleExpiry({
        expiresAt: claimed.session.expiresAt,
        previewSessionId: claimed.session.id,
        projectId,
      });
    } catch {
      await this.release(claimed.session);
      return { kind: "provider_error" };
    }

    try {
      const contentBasePath =
        await this.options.createContentBasePath({
          expiresAt: claimed.session.expiresAt,
          issuedAt: claimed.session.createdAt,
          previewSessionId: claimed.session.id,
          projectId,
        });
      const started = await runtime.startPreview(
        toRuntimeHandle(claimed.session, lease.runtimeId),
        {
          contentBasePath,
          port: projectPreviewPort,
          preset: "vite-v1",
          processTimeoutMs: this.sessionDurationMs + 15_000,
          startupTimeoutMs: this.startupTimeoutMs,
        },
      );
      const running = await this.options.previewSessions.markRunning(
        claimed.session.id,
        started.providerProcessRef,
        this.timestamp(),
      );
      if (!running) {
        await runtime
          .terminatePreview(
            toRuntimeHandle(claimed.session, lease.runtimeId),
            started.providerProcessRef,
            "failed",
          )
          .catch(() => undefined);
        await this.release(claimed.session);
        return { kind: "provider_error" };
      }

      return {
        kind: "started",
        status: {
          expiresAt: running.expiresAt,
          issuedAt: running.createdAt,
          kind: "running",
          sessionId: running.id,
        },
      };
    } catch {
      await this.release(claimed.session);
      return { kind: "provider_error" };
    }
  }

  async inspect(projectId: string): Promise<InspectProjectPreviewResult> {
    const session =
      await this.options.previewSessions.findByProjectId(projectId);
    if (!session) {
      return { expiresAt: null, kind: "stopped" };
    }
    if (session.status === "starting" || !session.providerProcessRef) {
      return toPublicStatus(session);
    }

    const lease = await this.options.sandboxLeases.findByProjectId(projectId);
    if (
      !lease?.providerRef ||
      lease.id !== session.sandboxLeaseId ||
      lease.providerRef !== session.providerSandboxRef
    ) {
      await this.releaseAndScheduleIdle(session, null);
      return { expiresAt: null, kind: "stopped" };
    }
    if (lease.runtimeId !== this.options.sandboxRuntimeId) {
      return { kind: "runtime_mismatch" };
    }

    let runtime: SandboxPreviewRuntime | null;
    try {
      runtime = this.options.getSandboxRuntime(lease.runtimeId);
    } catch {
      return { kind: "provider_error" };
    }
    if (!runtime) {
      return { kind: "runtime_mismatch" };
    }

    try {
      const running = await runtime.isPreviewRunning(
        toRuntimeHandle(session, lease.runtimeId),
        session.providerProcessRef,
        session.port,
      );
      if (running) {
        return toPublicStatus(session);
      }
    } catch {
      return { kind: "provider_error" };
    }

    await this.releaseAndScheduleIdle(session, lease.updatedAt);
    return { expiresAt: null, kind: "stopped" };
  }

  async stop(projectId: string): Promise<StopProjectPreviewResult> {
    const session =
      await this.options.previewSessions.findByProjectId(projectId);
    if (!session) {
      return { kind: "stopped" };
    }
    if (session.status === "starting" || !session.providerProcessRef) {
      return { kind: "project_busy" };
    }

    const lease = await this.options.sandboxLeases.findByProjectId(projectId);
    if (
      !lease?.providerRef ||
      lease.id !== session.sandboxLeaseId ||
      lease.providerRef !== session.providerSandboxRef
    ) {
      await this.releaseAndScheduleIdle(session, null);
      return { kind: "stopped" };
    }
    if (lease.runtimeId !== this.options.sandboxRuntimeId) {
      return { kind: "provider_error" };
    }

    let runtime: SandboxPreviewRuntime | null;
    try {
      runtime = this.options.getSandboxRuntime(lease.runtimeId);
    } catch {
      return { kind: "provider_error" };
    }
    if (!runtime) {
      return { kind: "provider_error" };
    }
    try {
      await runtime.terminatePreview(
        toRuntimeHandle(session, lease.runtimeId),
        session.providerProcessRef,
        "client_stopped",
      );
    } catch {
      return { kind: "provider_error" };
    }

    await this.releaseAndScheduleIdle(session, lease.updatedAt);
    return { kind: "stopped" };
  }

  async expire(projectId: string, previewSessionId: string) {
    const session =
      await this.options.previewSessions.findById(previewSessionId);
    if (!session || session.projectId !== projectId) {
      return { released: false };
    }

    const lease = await this.options.sandboxLeases.findByProjectId(projectId);
    if (
      session.providerProcessRef &&
      lease?.providerRef === session.providerSandboxRef &&
      lease.id === session.sandboxLeaseId
    ) {
      let runtime: SandboxPreviewRuntime | null;
      try {
        runtime = this.options.getSandboxRuntime(lease.runtimeId);
      } catch {
        return { released: false };
      }
      if (!runtime) {
        return { released: false };
      }
      try {
        await runtime.terminatePreview(
          toRuntimeHandle(session, lease.runtimeId),
          session.providerProcessRef,
          "expired",
        );
      } catch {
        return { released: false };
      }
    }

    return {
      released: await this.releaseAndScheduleIdle(
        session,
        lease?.providerRef === session.providerSandboxRef
          ? lease.updatedAt
          : null,
      ),
    };
  }

  async fetch(
    projectId: string,
    previewSessionId: string,
    request: SandboxPreviewRequest,
  ): Promise<FetchProjectPreviewResult> {
    const session =
      await this.options.previewSessions.findById(previewSessionId);
    if (
      !session ||
      session.projectId !== projectId ||
      session.status !== "running" ||
      !session.providerProcessRef
    ) {
      return { kind: "not_found" };
    }

    const lease = await this.options.sandboxLeases.findByProjectId(projectId);
    if (
      !lease?.providerRef ||
      lease.id !== session.sandboxLeaseId ||
      lease.providerRef !== session.providerSandboxRef
    ) {
      await this.releaseAndScheduleIdle(session, null);
      return { kind: "sandbox_unavailable" };
    }
    if (lease.runtimeId !== this.options.sandboxRuntimeId) {
      return { kind: "runtime_mismatch" };
    }

    let runtime: SandboxPreviewRuntime | null;
    try {
      runtime = this.options.getSandboxRuntime(lease.runtimeId);
    } catch {
      return { kind: "provider_error" };
    }
    if (!runtime) {
      return { kind: "runtime_mismatch" };
    }
    try {
      return {
        kind: "ok",
        response: await runtime.fetchPreview(
          toRuntimeHandle(session, lease.runtimeId),
          session.port,
          request,
        ),
      };
    } catch (error) {
      if (error instanceof SandboxUnavailableError) {
        await this.releaseAndScheduleIdle(session, lease.updatedAt);
        return { kind: "sandbox_unavailable" };
      }
      return { kind: "provider_error" };
    }
  }

  private async release(session: PreviewSessionRecord) {
    return this.options.previewSessions.release({
      expectedProviderSandboxRef: session.providerSandboxRef,
      sessionId: session.id,
    });
  }

  private async releaseAndScheduleIdle(
    session: PreviewSessionRecord,
    expectedLeaseUpdatedAt: string | null,
  ) {
    const released = await this.release(session);
    if (!released || !expectedLeaseUpdatedAt) {
      return released;
    }

    await this.options
      .scheduleIdleCleanup({
        expectedLeaseUpdatedAt,
        previewSessionId: session.id,
        projectId: session.projectId,
      })
      .catch(() => undefined);
    return released;
  }

  private timestamp() {
    return this.options.clock.now().toISOString();
  }
}

function toRuntimeHandle(
  session: PreviewSessionRecord,
  runtimeId: RuntimeKind,
): RuntimeHandle {
  return {
    id: session.providerSandboxRef,
    kind: runtimeId,
    sandboxLeaseId: session.sandboxLeaseId,
  };
}

function toPublicStatus(
  session: PreviewSessionRecord,
): Exclude<ProjectPreviewStatus, { kind: "stopped" }> {
  return {
    expiresAt: session.expiresAt,
    issuedAt: session.createdAt,
    kind: session.status,
    sessionId: session.id,
  };
}

function requirePositiveDuration(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}
