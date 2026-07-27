import type {
  RuntimeHandle,
  RuntimeKind,
  SandboxLifecycleRuntime,
  SandboxTerminalEvent,
  SandboxTerminalRuntime,
  SandboxTerminalSession,
  SandboxTerminalSize,
  TerminalCloseReason,
} from "../runtime/contract";
import type {
  AgentRunRepository,
  SandboxLeaseRecord,
  SandboxLeaseRepository,
  TerminalSessionRecord,
  TerminalSessionRepository,
} from "./ports";

export const defaultTerminalSessionDurationMs = 30 * 60 * 1_000;
export const maxTerminalInputBytes = 16 * 1_024;

const minTerminalColumns = 20;
const maxTerminalColumns = 240;
const minTerminalRows = 5;
const maxTerminalRows = 100;

export type ProjectTerminalRuntime = SandboxLifecycleRuntime & SandboxTerminalRuntime;

export type OpenProjectTerminalResult =
  | { connection: ProjectTerminalConnection; kind: "opened" }
  | { kind: "invalid_size" }
  | { kind: "project_busy" }
  | { kind: "provider_error" }
  | { kind: "runtime_mismatch" }
  | { kind: "sandbox_unavailable" };

export interface ProjectTerminalConnection {
  readonly expiresAt: string;
  close(reason: TerminalCloseReason): Promise<void>;
  events(): AsyncIterable<SandboxTerminalEvent>;
  resize(size: SandboxTerminalSize): Promise<void>;
  write(input: Uint8Array): Promise<void>;
}

export type ProjectTerminalServiceOptions = {
  agentRuns: Pick<AgentRunRepository, "findActiveByProjectId">;
  clock: { now(): Date };
  createId(): string;
  getSandboxRuntime(id: RuntimeKind): ProjectTerminalRuntime | null;
  sandboxLeases: SandboxLeaseRepository;
  sandboxRuntimeId: RuntimeKind;
  scheduleIdleCleanup(input: {
    expectedLeaseUpdatedAt: string;
    projectId: string;
    terminalSessionId: string;
  }): Promise<void>;
  scheduleExpiry(input: {
    expiresAt: string;
    projectId: string;
    terminalSessionId: string;
  }): Promise<void>;
  sessionDurationMs?: number;
  terminalSessions: TerminalSessionRepository;
  workingDirectory: string;
};

/**
 * Owns a single ephemeral Project PTY. D1 stores only the current exclusion
 * record and provider-private process reference; terminal bytes are never
 * persisted.
 */
export class ProjectTerminalService {
  private readonly sessionDurationMs: number;

  constructor(private readonly options: ProjectTerminalServiceOptions) {
    this.sessionDurationMs = options.sessionDurationMs ?? defaultTerminalSessionDurationMs;
    if (!Number.isSafeInteger(this.sessionDurationMs) || this.sessionDurationMs < 1) {
      throw new Error("Terminal session duration must be positive");
    }
  }

  async open(projectId: string, size: SandboxTerminalSize): Promise<OpenProjectTerminalResult> {
    if (!isValidTerminalSize(size)) {
      return { kind: "invalid_size" };
    }

    if (await this.options.agentRuns.findActiveByProjectId(projectId)) {
      return { kind: "project_busy" };
    }

    const now = this.options.clock.now();
    let lease = await this.options.sandboxLeases.getOrCreate({
      id: this.options.createId(),
      now: now.toISOString(),
      projectId,
      runtimeId: this.options.sandboxRuntimeId,
    });
    if (lease.runtimeId !== this.options.sandboxRuntimeId) {
      return { kind: "runtime_mismatch" };
    }

    let runtime: ProjectTerminalRuntime | null;
    try {
      runtime = this.options.getSandboxRuntime(lease.runtimeId);
    } catch {
      return { kind: "provider_error" };
    }
    if (!runtime) {
      return { kind: "sandbox_unavailable" };
    }

    const claimed = await this.options.terminalSessions.claim({
      expectedLeaseProviderRef: lease.providerRef,
      expectedLeaseUpdatedAt: lease.updatedAt,
      expiresAt: new Date(now.getTime() + this.sessionDurationMs).toISOString(),
      id: this.options.createId(),
      now: now.toISOString(),
      projectId,
      sandboxLeaseId: lease.id,
    });
    if (claimed.kind === "project_busy") {
      return claimed;
    }

    try {
      await this.options.scheduleExpiry({
        expiresAt: claimed.session.expiresAt,
        projectId,
        terminalSessionId: claimed.session.id,
      });
    } catch {
      await this.options.terminalSessions.release(claimed.session.id).catch(() => false);
      return { kind: "provider_error" };
    }

    let handle: RuntimeHandle | null = null;
    let terminal: SandboxTerminalSession | null = null;
    try {
      lease = await this.options.sandboxLeases.updateState({
        leaseId: lease.id,
        providerRef: lease.providerRef,
        status: "starting",
        updatedAt: this.timestamp(),
      });
      handle = await runtime.ensureLease({
        projectId,
        providerRef: lease.providerRef,
        sandboxLeaseId: lease.id,
      });
      assertRuntimeHandle(handle, runtime.kind, lease.id);

      lease = await this.options.sandboxLeases.updateState({
        leaseId: lease.id,
        providerRef: handle.id,
        status: "ready",
        updatedAt: this.timestamp(),
      });
      const sandboxBound = await this.options.terminalSessions.setProviderSandboxRef(
        claimed.session.id,
        handle.id,
        this.timestamp(),
      );
      if (!sandboxBound) {
        throw new Error("Terminal session was released during startup");
      }

      terminal = await runtime.startTerminal(handle, {
        ...size,
        cwd: this.options.workingDirectory,
      });
      const persisted = await this.options.terminalSessions.setProviderProcessRef(
        claimed.session.id,
        terminal.providerProcessRef,
        this.timestamp(),
      );
      if (!persisted) {
        throw new Error("Terminal session expired during startup");
      }

      lease = await this.options.sandboxLeases.updateState({
        leaseId: lease.id,
        providerRef: handle.id,
        status: "busy",
        updatedAt: this.timestamp(),
      });

      return {
        connection: new ManagedProjectTerminal({
          clock: this.options.clock,
          expiresAt: claimed.session.expiresAt,
          handle,
          runtime,
          scheduleIdleCleanup: this.options.scheduleIdleCleanup,
          session: terminal,
          sessionRecord: persisted,
          terminalSessions: this.options.terminalSessions,
        }),
        kind: "opened",
      };
    } catch {
      await cleanupFailedOpen({
        clock: this.options.clock,
        handle,
        lease,
        now: this.timestamp(),
        projectId,
        runtime,
        sandboxLeases: this.options.sandboxLeases,
        scheduleIdleCleanup: this.options.scheduleIdleCleanup,
        sessionId: claimed.session.id,
        terminal,
        terminalSessions: this.options.terminalSessions,
      });
      return { kind: "provider_error" };
    }
  }

  async expire(projectId: string, sessionId: string) {
    const session = await this.options.terminalSessions.findById(sessionId);
    if (!session || session.projectId !== projectId) {
      return { released: false, stoppedSandbox: false };
    }

    const lease = await this.options.sandboxLeases.findByProjectId(projectId);
    if (!lease || lease.id !== session.sandboxLeaseId) {
      return { released: false, stoppedSandbox: false };
    }

    if (!session.providerSandboxRef) {
      await markLeaseFailedBestEffort(
        this.options.sandboxLeases,
        lease,
        lease.providerRef,
        this.timestamp(),
      );
      return {
        released: await this.options.terminalSessions.release(session.id),
        stoppedSandbox: false,
      };
    }

    const runtime = this.options.getSandboxRuntime(lease.runtimeId);
    if (!runtime) {
      return { released: false, stoppedSandbox: false };
    }
    const handle = toRuntimeHandle(lease.runtimeId, lease.id, session.providerSandboxRef);

    if (session.providerProcessRef) {
      try {
        await runtime.terminateTerminal(handle, session.providerProcessRef, "expired");
        const released = await releaseTerminalAsIdle({
          clock: this.options.clock,
          handle,
          projectId,
          scheduleIdleCleanup: this.options.scheduleIdleCleanup,
          sessionId,
          terminalSessions: this.options.terminalSessions,
        });
        return { released, stoppedSandbox: false };
      } catch {
        // Fall through to isolating the entire provider sandbox.
      }
    }

    const released = await isolateSandboxAndRelease({
      handle,
      now: this.timestamp(),
      runtime,
      sessionId,
      terminalSessions: this.options.terminalSessions,
    });
    return { released, stoppedSandbox: released };
  }

  private timestamp() {
    return this.options.clock.now().toISOString();
  }
}

type ManagedProjectTerminalOptions = {
  clock: { now(): Date };
  expiresAt: string;
  handle: RuntimeHandle;
  runtime: ProjectTerminalRuntime;
  scheduleIdleCleanup: ProjectTerminalServiceOptions["scheduleIdleCleanup"];
  session: SandboxTerminalSession;
  sessionRecord: TerminalSessionRecord;
  terminalSessions: TerminalSessionRepository;
};

class ManagedProjectTerminal implements ProjectTerminalConnection {
  readonly expiresAt: string;

  private cleanup: Promise<void> | null = null;
  private readonly expiryTimer: ReturnType<typeof setTimeout>;

  constructor(private readonly options: ManagedProjectTerminalOptions) {
    this.expiresAt = options.expiresAt;
    const remainingMs = Math.max(
      1,
      new Date(options.expiresAt).getTime() - options.clock.now().getTime(),
    );
    this.expiryTimer = setTimeout(() => {
      void this.close("expired");
    }, remainingMs);
  }

  async close(reason: TerminalCloseReason) {
    return this.beginCleanup(() => this.closeAndRelease(reason));
  }

  async *events() {
    try {
      for await (const event of this.options.session.events()) {
        if (event.type === "terminal.exited") {
          await this.beginCleanup(() => this.releaseAsIdle());
          yield event;
          return;
        }
        yield event;
      }
      await this.beginCleanup(() => this.releaseAsIdle());
    } catch (error) {
      await this.beginCleanup(() => this.closeAndRelease("failed"));
      throw error;
    }
  }

  resize(size: SandboxTerminalSize) {
    if (!isValidTerminalSize(size)) {
      return Promise.reject(new Error("Terminal size is invalid"));
    }
    if (this.cleanup) {
      return Promise.reject(new Error("Terminal is closed"));
    }
    return this.options.session.resize(size);
  }

  write(input: Uint8Array) {
    if (input.byteLength < 1 || input.byteLength > maxTerminalInputBytes) {
      return Promise.reject(new Error("Terminal input size is invalid"));
    }
    if (this.cleanup) {
      return Promise.reject(new Error("Terminal is closed"));
    }
    return this.options.session.write(input);
  }

  private async closeAndRelease(reason: TerminalCloseReason) {
    clearTimeout(this.expiryTimer);
    try {
      await this.options.session.close(reason);
      await this.releaseAsIdle();
    } catch {
      await this.isolateAndRelease();
    }
  }

  private beginCleanup(operation: () => Promise<void>) {
    if (!this.cleanup) {
      this.cleanup = operation();
    }
    return this.cleanup;
  }

  private async releaseAsIdle() {
    clearTimeout(this.expiryTimer);
    await releaseTerminalAsIdle({
      clock: this.options.clock,
      handle: this.options.handle,
      projectId: this.options.sessionRecord.projectId,
      scheduleIdleCleanup: this.options.scheduleIdleCleanup,
      sessionId: this.options.sessionRecord.id,
      terminalSessions: this.options.terminalSessions,
    });
  }

  private async isolateAndRelease() {
    clearTimeout(this.expiryTimer);
    await isolateSandboxAndRelease({
      handle: this.options.handle,
      now: this.options.clock.now().toISOString(),
      runtime: this.options.runtime,
      sessionId: this.options.sessionRecord.id,
      terminalSessions: this.options.terminalSessions,
    });
  }
}

function isValidTerminalSize(size: SandboxTerminalSize) {
  return (
    Number.isSafeInteger(size.cols) &&
    size.cols >= minTerminalColumns &&
    size.cols <= maxTerminalColumns &&
    Number.isSafeInteger(size.rows) &&
    size.rows >= minTerminalRows &&
    size.rows <= maxTerminalRows
  );
}

function assertRuntimeHandle(
  handle: RuntimeHandle,
  runtimeId: RuntimeKind,
  sandboxLeaseId: string,
) {
  if (handle.kind !== runtimeId || handle.sandboxLeaseId !== sandboxLeaseId || !handle.id) {
    throw new Error("Terminal runtime returned an invalid handle");
  }
}

async function releaseTerminalAsIdle(input: {
  clock: { now(): Date };
  handle: RuntimeHandle;
  projectId: string;
  scheduleIdleCleanup: ProjectTerminalServiceOptions["scheduleIdleCleanup"];
  sessionId: string;
  terminalSessions: TerminalSessionRepository;
}) {
  const leaseUpdatedAt = input.clock.now().toISOString();
  const released = await input.terminalSessions.releaseAndMarkLeaseIdle({
    expectedProviderSandboxRef: input.handle.id,
    now: leaseUpdatedAt,
    sessionId: input.sessionId,
  });
  if (!released) {
    return false;
  }
  try {
    await input.scheduleIdleCleanup({
      expectedLeaseUpdatedAt: leaseUpdatedAt,
      projectId: input.projectId,
      terminalSessionId: input.sessionId,
    });
  } catch {
    // The provider sandbox timeout remains the final cleanup bound.
  }
  return true;
}

async function isolateSandboxAndRelease(input: {
  handle: RuntimeHandle;
  now: string;
  runtime: ProjectTerminalRuntime;
  sessionId: string;
  terminalSessions: TerminalSessionRepository;
}) {
  try {
    await input.runtime.stop(input.handle, "failed");
    return await input.terminalSessions.releaseAndMarkLeaseStopped({
      expectedProviderSandboxRef: input.handle.id,
      now: input.now,
      sessionId: input.sessionId,
    });
  } catch {
    await input.terminalSessions
      .markLeaseFailedKeepingSession({
        expectedProviderSandboxRef: input.handle.id,
        now: input.now,
        sessionId: input.sessionId,
      })
      .catch(() => false);
    return false;
  }
}

async function cleanupFailedOpen(input: {
  clock: { now(): Date };
  handle: RuntimeHandle | null;
  lease: SandboxLeaseRecord;
  now: string;
  projectId: string;
  runtime: ProjectTerminalRuntime;
  sandboxLeases: SandboxLeaseRepository;
  scheduleIdleCleanup: ProjectTerminalServiceOptions["scheduleIdleCleanup"];
  sessionId: string;
  terminal: SandboxTerminalSession | null;
  terminalSessions: TerminalSessionRepository;
}) {
  if (!input.handle) {
    await markLeaseFailedBestEffort(
      input.sandboxLeases,
      input.lease,
      input.lease.providerRef,
      input.now,
    );
    await input.terminalSessions.release(input.sessionId).catch(() => false);
    return;
  }

  if (input.terminal) {
    try {
      await input.terminal.close("failed");
      await releaseTerminalAsIdle({
        clock: input.clock,
        handle: input.handle,
        projectId: input.projectId,
        scheduleIdleCleanup: input.scheduleIdleCleanup,
        sessionId: input.sessionId,
        terminalSessions: input.terminalSessions,
      });
      return;
    } catch {
      // Isolate the entire sandbox below.
    }
  }

  await isolateSandboxAndRelease({
    handle: input.handle,
    now: input.now,
    runtime: input.runtime,
    sessionId: input.sessionId,
    terminalSessions: input.terminalSessions,
  });
}

function toRuntimeHandle(
  kind: RuntimeKind,
  sandboxLeaseId: string,
  providerSandboxRef: string,
): RuntimeHandle {
  return {
    id: providerSandboxRef,
    kind,
    sandboxLeaseId,
  };
}

async function markLeaseFailedBestEffort(
  sandboxLeases: Pick<SandboxLeaseRepository, "updateState">,
  lease: SandboxLeaseRecord,
  providerRef: string | null,
  updatedAt: string,
) {
  try {
    await sandboxLeases.updateState({
      leaseId: lease.id,
      providerRef,
      status: "failed",
      updatedAt,
    });
  } catch {
    // Provider timeout remains the final cleanup bound.
  }
}
