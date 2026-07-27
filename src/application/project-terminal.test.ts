import { describe, expect, it, vi } from "vitest";

import type {
  AgentRunRecord,
  SandboxLeaseRecord,
  SandboxLeaseRepository,
  TerminalSessionRecord,
  TerminalSessionRepository,
} from "./ports";
import { ProjectTerminalService, type ProjectTerminalRuntime } from "./project-terminal";
import type {
  RuntimeHandle,
  SandboxTerminalEvent,
  SandboxTerminalSession,
  SandboxTerminalSize,
} from "../runtime/contract";

const now = "2026-07-26T08:00:00.000Z";

describe("ProjectTerminalService", () => {
  it("opens one PTY, relays IO, and releases the Project when it exits", async () => {
    const harness = createHarness();

    const result = await harness.service.open("project-1", {
      cols: 100,
      rows: 30,
    });

    expect(result.kind).toBe("opened");
    if (result.kind !== "opened") {
      return;
    }

    await result.connection.write(new TextEncoder().encode("pwd\r"));
    await result.connection.resize({ cols: 120, rows: 36 });
    const events = [];
    for await (const event of result.connection.events()) {
      events.push(event);
    }

    expect(harness.runtime.ensureLease).toHaveBeenCalledWith({
      projectId: "project-1",
      providerRef: null,
      sandboxLeaseId: "lease-1",
    });
    expect(harness.runtime.startTerminal).toHaveBeenCalledWith(
      {
        id: "sandbox-1",
        kind: "e2b",
        sandboxLeaseId: "lease-1",
      },
      {
        cols: 100,
        cwd: "/workspace",
        rows: 30,
      },
    );
    expect(harness.session.inputs).toEqual([new TextEncoder().encode("pwd\r")]);
    expect(harness.session.sizes).toEqual([{ cols: 120, rows: 36 }]);
    expect(events).toEqual(harness.session.outputEvents);
    expect(harness.terminalSessions.releaseAndMarkLeaseIdle).toHaveBeenCalledWith({
      expectedProviderSandboxRef: "sandbox-1",
      now,
      sessionId: "terminal-1",
    });
    expect(harness.scheduleExpiry).toHaveBeenCalledWith({
      expiresAt: "2026-07-26T08:30:00.000Z",
      projectId: "project-1",
      terminalSessionId: "terminal-1",
    });
    expect(harness.scheduleIdleCleanup).toHaveBeenCalledWith({
      expectedLeaseUpdatedAt: now,
      projectId: "project-1",
      terminalSessionId: "terminal-1",
    });
    expect(harness.leaseStatuses).toEqual(["starting", "ready", "busy"]);
  });

  it("returns project_busy before creating a sandbox when an AgentRun is active", async () => {
    const harness = createHarness({ activeRun: true });

    await expect(harness.service.open("project-1", { cols: 80, rows: 24 })).resolves.toEqual({
      kind: "project_busy",
    });

    expect(harness.sandboxLeases.getOrCreate).not.toHaveBeenCalled();
    expect(harness.runtime.ensureLease).not.toHaveBeenCalled();
  });

  it("uses the atomic Terminal claim to reject a concurrent opener", async () => {
    const harness = createHarness({ claimBusy: true });

    await expect(harness.service.open("project-1", { cols: 80, rows: 24 })).resolves.toEqual({
      kind: "project_busy",
    });

    expect(harness.runtime.ensureLease).not.toHaveBeenCalled();
  });

  it("does not start provider state when durable expiry scheduling fails", async () => {
    const harness = createHarness({ scheduleExpiryError: true });

    await expect(harness.service.open("project-1", { cols: 80, rows: 24 })).resolves.toEqual({
      kind: "provider_error",
    });

    expect(harness.terminalSessions.release).toHaveBeenCalledWith("terminal-1");
    expect(harness.runtime.ensureLease).not.toHaveBeenCalled();
  });

  it("makes Terminal explicitly unavailable for a runtime without PTY capability", async () => {
    const harness = createHarness({ runtimeAvailable: false });

    await expect(harness.service.open("project-1", { cols: 80, rows: 24 })).resolves.toEqual({
      kind: "sandbox_unavailable",
    });

    expect(harness.terminalSessions.claim).not.toHaveBeenCalled();
  });

  it("isolates the sandbox before releasing the claim when PTY startup fails", async () => {
    const harness = createHarness({ startError: true });

    await expect(harness.service.open("project-1", { cols: 80, rows: 24 })).resolves.toEqual({
      kind: "provider_error",
    });

    expect(harness.runtime.stop).toHaveBeenCalledWith(
      {
        id: "sandbox-1",
        kind: "e2b",
        sandboxLeaseId: "lease-1",
      },
      "failed",
    );
    expect(harness.terminalSessions.releaseAndMarkLeaseStopped).toHaveBeenCalledWith({
      expectedProviderSandboxRef: "sandbox-1",
      now,
      sessionId: "terminal-1",
    });
    expect(harness.leaseStatuses).toEqual(["starting", "ready"]);
  });

  it("validates dimensions before touching persistence", async () => {
    const harness = createHarness();

    await expect(harness.service.open("project-1", { cols: 10, rows: 2 })).resolves.toEqual({
      kind: "invalid_size",
    });

    expect(harness.sandboxLeases.getOrCreate).not.toHaveBeenCalled();
  });

  it("closes an active PTY once and rejects later input", async () => {
    const harness = createHarness({ keepTerminalOpen: true });
    const result = await harness.service.open("project-1", {
      cols: 80,
      rows: 24,
    });
    expect(result.kind).toBe("opened");
    if (result.kind !== "opened") {
      return;
    }

    await Promise.all([
      result.connection.close("client_closed"),
      result.connection.close("client_closed"),
    ]);

    expect(harness.session.close).toHaveBeenCalledTimes(1);
    await expect(result.connection.write(new TextEncoder().encode("ls\r"))).rejects.toThrow(
      "closed",
    );
  });

  it("keeps the Project locked when neither PTY nor sandbox stop is confirmed", async () => {
    const harness = createHarness({
      closeError: true,
      keepTerminalOpen: true,
      stopError: true,
    });
    const result = await harness.service.open("project-1", {
      cols: 80,
      rows: 24,
    });
    expect(result.kind).toBe("opened");
    if (result.kind !== "opened") {
      return;
    }

    await result.connection.close("failed");

    expect(harness.terminalSessions.markLeaseFailedKeepingSession).toHaveBeenCalledWith({
      expectedProviderSandboxRef: "sandbox-1",
      now,
      sessionId: "terminal-1",
    });
    expect(harness.terminalSessions.releaseAndMarkLeaseStopped).not.toHaveBeenCalled();
    expect(harness.terminalSessions.release).not.toHaveBeenCalled();
  });

  it("expires the persisted PTY only inside its recorded provider sandbox", async () => {
    const harness = createHarness({ keepTerminalOpen: true });
    const opened = await harness.service.open("project-1", {
      cols: 80,
      rows: 24,
    });
    expect(opened.kind).toBe("opened");

    await expect(harness.service.expire("project-1", "terminal-1")).resolves.toEqual({
      released: true,
      stoppedSandbox: false,
    });
    expect(harness.runtime.terminateTerminal).toHaveBeenCalledWith(
      {
        id: "sandbox-1",
        kind: "e2b",
        sandboxLeaseId: "lease-1",
      },
      "9001",
      "expired",
    );
  });
});

function createHarness(
  options: {
    activeRun?: boolean;
    claimBusy?: boolean;
    closeError?: boolean;
    keepTerminalOpen?: boolean;
    runtimeAvailable?: boolean;
    scheduleExpiryError?: boolean;
    startError?: boolean;
    stopError?: boolean;
  } = {},
) {
  const leaseStatuses: string[] = [];
  let lease: SandboxLeaseRecord = {
    createdAt: now,
    id: "lease-1",
    projectId: "project-1",
    providerRef: null,
    runtimeId: "e2b",
    status: "stopped",
    updatedAt: now,
  };
  let terminalRecord: TerminalSessionRecord = {
    createdAt: now,
    expiresAt: "2026-07-26T08:30:00.000Z",
    id: "terminal-1",
    projectId: "project-1",
    providerProcessRef: null,
    providerSandboxRef: null,
    sandboxLeaseId: "lease-1",
    updatedAt: now,
  };
  const sandboxLeases = {
    getOrCreate: vi.fn(async () => lease),
    findByProjectId: vi.fn(async () => lease),
    updateState: vi.fn(
      async (input: {
        leaseId: string;
        providerRef: string | null;
        status: SandboxLeaseRecord["status"];
        updatedAt: string;
      }) => {
        leaseStatuses.push(input.status);
        lease = {
          ...lease,
          providerRef: input.providerRef,
          status: input.status,
          updatedAt: input.updatedAt,
        };
        return lease;
      },
    ),
  } as unknown as SandboxLeaseRepository;
  const terminalSessions = {
    claim: vi.fn(async () =>
      options.claimBusy
        ? ({ kind: "project_busy" } as const)
        : ({
            kind: "claimed",
            session: terminalRecord,
          } as const),
    ),
    findById: vi.fn(async () => terminalRecord),
    findByProjectId: vi.fn(async () => terminalRecord),
    markLeaseFailedKeepingSession: vi.fn(async () => true),
    release: vi.fn(async () => true),
    releaseAndMarkLeaseIdle: vi.fn(async () => true),
    releaseAndMarkLeaseStopped: vi.fn(async () => true),
    setProviderProcessRef: vi.fn(async () => {
      terminalRecord = {
        ...terminalRecord,
        providerProcessRef: "9001",
      };
      return terminalRecord;
    }),
    setProviderSandboxRef: vi.fn(async () => {
      terminalRecord = {
        ...terminalRecord,
        providerSandboxRef: "sandbox-1",
      };
      return terminalRecord;
    }),
  } as unknown as TerminalSessionRepository;
  const session = new FakeTerminalSession(
    options.keepTerminalOpen ?? false,
    options.closeError ?? false,
  );
  const handle: RuntimeHandle = {
    id: "sandbox-1",
    kind: "e2b",
    sandboxLeaseId: "lease-1",
  };
  const runtime = {
    ensureLease: vi.fn(async () => handle),
    kind: "e2b",
    startTerminal: vi.fn(async () => {
      if (options.startError) {
        throw new Error("PTY unavailable");
      }
      return session;
    }),
    stop: vi.fn(async () => {
      if (options.stopError) {
        throw new Error("Sandbox stop failed");
      }
    }),
    terminateTerminal: vi.fn(async () => undefined),
  } satisfies ProjectTerminalRuntime;
  const scheduleIdleCleanup = vi.fn(async () => undefined);
  const scheduleExpiry = vi.fn(async () => {
    if (options.scheduleExpiryError) {
      throw new Error("Workflow unavailable");
    }
  });
  const service = new ProjectTerminalService({
    agentRuns: {
      findActiveByProjectId: vi.fn(async () => (options.activeRun ? ({} as AgentRunRecord) : null)),
    },
    clock: { now: () => new Date(now) },
    createId: createSequentialId(),
    getSandboxRuntime: () => (options.runtimeAvailable === false ? null : runtime),
    sandboxLeases,
    sandboxRuntimeId: "e2b",
    scheduleExpiry,
    scheduleIdleCleanup,
    sessionDurationMs: 30 * 60 * 1_000,
    terminalSessions,
    workingDirectory: "/workspace",
  });

  return {
    leaseStatuses,
    runtime,
    sandboxLeases,
    scheduleExpiry,
    scheduleIdleCleanup,
    service,
    session,
    terminalSessions,
  };
}

class FakeTerminalSession implements SandboxTerminalSession {
  readonly close: SandboxTerminalSession["close"];
  readonly inputs: Uint8Array[] = [];
  readonly outputEvents: SandboxTerminalEvent[] = [
    {
      chunk: new TextEncoder().encode("ready"),
      sandboxLeaseId: "lease-1",
      type: "terminal.output",
    },
    {
      exitCode: 0,
      sandboxLeaseId: "lease-1",
      type: "terminal.exited",
    },
  ];
  readonly providerProcessRef = "9001";
  readonly sizes: SandboxTerminalSize[] = [];

  constructor(
    private readonly keepOpen: boolean,
    closeError: boolean,
  ) {
    this.close = vi.fn(async (_reason) => {
      if (closeError) {
        throw new Error("PTY close failed");
      }
    });
  }

  async *events() {
    if (this.keepOpen) {
      await new Promise<void>(() => undefined);
      return;
    }
    yield* this.outputEvents;
  }

  async resize(size: SandboxTerminalSize) {
    this.sizes.push(size);
  }

  async write(input: Uint8Array) {
    this.inputs.push(input);
  }
}

function createSequentialId() {
  const ids = ["lease-created", "terminal-1"];
  return () => ids.shift() ?? "unexpected-id";
}
