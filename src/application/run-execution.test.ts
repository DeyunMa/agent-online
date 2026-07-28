import { describe, expect, it } from "vitest";

import type { AgentExecution, AgentRuntime } from "../agent/contract";
import { canTransitionAgentRun, isTerminalAgentRun } from "../domain/agent-run";
import type { DiagnosticEvent } from "../observability/contract";
import type {
  EnsureLeaseInput,
  ProcessTerminationReason,
  RuntimeHandle,
  SandboxCommand,
  SandboxProcessSession,
  SandboxRuntime,
  SandboxStopReason,
} from "../runtime/contract";
import type {
  AgentRunRecord,
  AgentRunRepository,
  CreateQueuedAgentRunResult,
  MessageRecord,
  MessageRepository,
  SandboxLeaseRecord,
  SandboxLeaseRepository,
} from "./ports";
import { RunExecutionService } from "./run-execution";

const capabilities = {
  modelGateway: true,
  processTermination: true,
  stdin: true,
  streamingOutput: true,
  tty: false,
} as const;

describe("RunExecutionService", () => {
  it("reloads the private prompt from D1 and persists only the visible reply", async () => {
    const fixture = createFixture();
    const prompts: string[] = [];
    const service = fixture.createService(completingAgent(prompts));

    const completed = await service.execute({
      projectId: "project_1",
      runId: "run_1",
    });

    expect(prompts).toEqual(["Build the requested application."]);
    expect(completed.status).toBe("succeeded");
    expect(fixture.messages.records.find((message) => message.role === "assistant")).toMatchObject({
      content: "Completed from the sandbox.",
      role: "assistant",
    });
    expect(completed.providerProcessRef).toBeNull();
    expect(fixture.diagnosticEvents.map((event) => event.event)).toEqual([
      "agent_run.execution_started",
      "agent_run.execution_finished",
    ]);
    expect(JSON.stringify(fixture.diagnosticEvents)).not.toContain(
      "Build the requested application",
    );
  });

  it("classifies an Agent process failure without persisting provider details", async () => {
    const fixture = createFixture();
    const service = fixture.createService(failingAgent());

    const completed = await service.execute({
      projectId: "project_1",
      runId: "run_1",
    });

    expect(completed).toMatchObject({
      failureCode: "run.agent_process_failed",
      status: "failed",
    });
    expect(fixture.diagnosticEvents).toContainEqual(
      expect.objectContaining({
        errorCode: "AGENT_PROCESS_FAILED",
        event: "agent_run.stage_failed",
        failureCode: "run.agent_process_failed",
        runId: "run_1",
      }),
    );
    expect(JSON.stringify(fixture.diagnosticEvents)).not.toContain("sandbox_1");
  });

  it("times out a long-running execution through the AgentRuntime", async () => {
    const fixture = createFixture();
    const service = fixture.createService(blockingAgent(), 5);

    const completed = await service.execute({
      projectId: "project_1",
      runId: "run_1",
    });

    expect(completed.status).toBe("timed_out");
    expect(completed.providerProcessRef).toBeNull();
  });

  it("cancels only the provider process and preserves the Project sandbox", async () => {
    const fixture = createFixture({
      lease: createLease({
        providerRef: "sandbox_1",
        status: "busy",
      }),
      run: createRun({
        providerProcessRef: "42",
        startedAt: "2026-07-25T00:00:00.000Z",
        status: "running",
      }),
    });
    const service = fixture.createService(blockingAgent());

    const cancelled = await service.cancel({
      projectId: "project_1",
      runId: "run_1",
    });

    expect(cancelled.status).toBe("cancelled");
    expect(fixture.runtime.terminatedProcesses).toEqual([
      { processRef: "42", reason: "cancelled" },
    ]);
    expect(fixture.runtime.stoppedSandboxes).toEqual([]);
    expect(fixture.sandboxLeases.lease).toMatchObject({
      providerRef: "sandbox_1",
      status: "idle",
    });
  });

  it("fails closed by stopping the sandbox when a recovered Run has no process reference", async () => {
    const fixture = createFixture({
      lease: createLease({
        providerRef: "sandbox_1",
        status: "busy",
      }),
      run: createRun({
        providerProcessRef: null,
        startedAt: "2026-07-25T00:00:00.000Z",
        status: "running",
      }),
    });
    const service = fixture.createService(blockingAgent());

    const recovered = await service.execute({
      projectId: "project_1",
      runId: "run_1",
    });

    expect(recovered.status).toBe("interrupted");
    expect(fixture.runtime.stoppedSandboxes).toEqual([
      { providerRef: "sandbox_1", reason: "failed" },
    ]);
    expect(fixture.sandboxLeases.lease).toMatchObject({
      providerRef: null,
      status: "stopped",
    });
  });

  it("atomically detaches and stops only the latest Run's idle sandbox", async () => {
    const fixture = createFixture({
      lease: createLease({
        providerRef: "sandbox_1",
        status: "idle",
      }),
      run: createRun({
        finishedAt: "2026-07-25T00:05:00.000Z",
        status: "succeeded",
      }),
    });
    const service = fixture.createService(blockingAgent());

    const stopped = await service.stopSandboxIfIdle({
      projectId: "project_1",
      runId: "run_1",
    });

    expect(stopped).toEqual({ detached: true, stopped: true });
    expect(fixture.runtime.stoppedSandboxes).toEqual([
      { providerRef: "sandbox_1", reason: "idle" },
    ]);
    expect(fixture.sandboxLeases.lease).toMatchObject({
      providerRef: null,
      status: "stopped",
    });
  });

  it("treats a hard-deleted Project Run as an idle-cleanup no-op", async () => {
    const fixture = createFixture();
    fixture.agentRuns.remove("run_1");

    await expect(
      fixture.createService(blockingAgent()).stopSandboxIfIdle({
        projectId: "project_1",
        runId: "run_1",
      }),
    ).resolves.toEqual({ detached: false, stopped: false });
    expect(fixture.runtime.stoppedSandboxes).toEqual([]);
  });

  it("stops a Terminal-idle sandbox only while its Lease activity timestamp is unchanged", async () => {
    const current = createFixture({
      lease: createLease({
        providerRef: "sandbox_1",
        status: "idle",
        updatedAt: "2026-07-25T00:10:00.000Z",
      }),
      run: createRun({
        finishedAt: "2026-07-25T00:05:00.000Z",
        status: "succeeded",
      }),
    });
    const stale = createFixture({
      lease: createLease({
        providerRef: "sandbox_2",
        status: "idle",
        updatedAt: "2026-07-25T00:11:00.000Z",
      }),
      run: createRun({
        finishedAt: "2026-07-25T00:05:00.000Z",
        status: "succeeded",
      }),
    });

    await expect(
      current.createService(blockingAgent()).stopSandboxAfterActivityIdle({
        expectedLeaseUpdatedAt: "2026-07-25T00:10:00.000Z",
        projectId: "project_1",
      }),
    ).resolves.toEqual({ detached: true, stopped: true });
    await expect(
      stale.createService(blockingAgent()).stopSandboxAfterActivityIdle({
        expectedLeaseUpdatedAt: "2026-07-25T00:10:00.000Z",
        projectId: "project_1",
      }),
    ).resolves.toEqual({ detached: false, stopped: false });

    expect(current.runtime.stoppedSandboxes).toEqual([
      { providerRef: "sandbox_1", reason: "idle" },
    ]);
    expect(stale.runtime.stoppedSandboxes).toEqual([]);
  });
});

function createFixture(overrides: { lease?: SandboxLeaseRecord; run?: AgentRunRecord } = {}) {
  const run = overrides.run ?? createRun();
  const messages = new InMemoryMessageRepository([
    {
      agentRunId: null,
      content: "Build the requested application.",
      createdAt: run.createdAt,
      id: "message_1",
      projectId: run.projectId,
      role: "user",
      sequence: 0,
    },
  ]);
  const agentRuns = new InMemoryAgentRunRepository([run], messages);
  const sandboxLeases = new InMemorySandboxLeaseRepository(
    overrides.lease ?? createLease(),
    agentRuns,
  );
  const runtime = new RecordingSandboxRuntime();
  const clock = new MonotonicClock();
  const diagnosticEvents: DiagnosticEvent[] = [];

  return {
    agentRuns,
    createService(agentRuntime: AgentRuntime, runTimeoutMs = 1_000) {
      return new RunExecutionService({
        agentRuns,
        clock,
        createId: () => "assistant_message_1",
        diagnostics: {
          report(event) {
            diagnosticEvents.push(event);
          },
        },
        getAgentRuntime: () => agentRuntime,
        getSandboxRuntime: () => runtime,
        async issueModelAccess({ run: currentRun }) {
          return {
            baseUrl: "https://agent-online.example/api/model-gateway/v1",
            bearerToken: "private-capability",
            maxOutputTokens: 4_096,
            modelId: currentRun.modelId,
          };
        },
        messages,
        runTimeoutMs,
        sandboxLeases,
        workingDirectory: "/workspace",
      });
    },
    diagnosticEvents,
    messages,
    runtime,
    sandboxLeases,
  };
}

function failingAgent(): AgentRuntime {
  return {
    capabilities,
    id: "pi",
    async start(_context, input): Promise<AgentExecution> {
      return {
        async cancel() {},
        async *events() {
          yield {
            agentRuntimeId: "pi",
            agentRunId: input.agentRunId,
            exitCode: 7,
            finalText: null,
            sandboxLeaseId: input.sandboxLeaseId,
            type: "agent.completed",
          };
        },
        providerProcessRef: "private-process-ref",
      };
    },
  };
}

function completingAgent(prompts: string[]): AgentRuntime {
  return {
    capabilities,
    id: "pi",
    async start(_context, input): Promise<AgentExecution> {
      prompts.push(input.prompt);
      return {
        async cancel() {},
        async *events() {
          yield {
            agentRuntimeId: "pi",
            agentRunId: input.agentRunId,
            exitCode: 0,
            finalText: "Completed from the sandbox.",
            sandboxLeaseId: input.sandboxLeaseId,
            type: "agent.completed",
          };
        },
        providerProcessRef: "42",
      };
    },
  };
}

function blockingAgent(): AgentRuntime {
  return {
    capabilities,
    id: "pi",
    async start(_context, input): Promise<AgentExecution> {
      return {
        async cancel() {},
        async *events() {
          yield {
            agentRuntimeId: "pi",
            agentRunId: input.agentRunId,
            sandboxLeaseId: input.sandboxLeaseId,
            type: "agent.started",
          };
          await new Promise<void>(() => undefined);
        },
        providerProcessRef: "42",
      };
    },
  };
}

class RecordingSandboxRuntime implements SandboxRuntime {
  readonly filesystemScope = "lease" as const;
  readonly kind = "e2b" as const;
  readonly stoppedSandboxes: Array<{
    providerRef: string;
    reason: SandboxStopReason;
  }> = [];
  readonly terminatedProcesses: Array<{
    processRef: string;
    reason: ProcessTerminationReason;
  }> = [];

  async ensureLease(input: EnsureLeaseInput): Promise<RuntimeHandle> {
    return {
      id: input.providerRef ?? "sandbox_1",
      kind: this.kind,
      sandboxLeaseId: input.sandboxLeaseId,
    };
  }

  async startProcess(
    _handle: RuntimeHandle,
    _command: SandboxCommand,
  ): Promise<SandboxProcessSession> {
    throw new Error("Agent fixture starts no provider process");
  }

  async listDirectory() {
    return [];
  }

  async readFile() {
    return new Uint8Array();
  }

  async terminateProcess(
    _handle: RuntimeHandle,
    providerProcessRef: string,
    reason: ProcessTerminationReason,
  ) {
    this.terminatedProcesses.push({ processRef: providerProcessRef, reason });
  }

  async stop(handle: RuntimeHandle, reason: SandboxStopReason) {
    this.stoppedSandboxes.push({ providerRef: handle.id, reason });
  }

  async writeFile(_handle: RuntimeHandle, _path: string, _content: string) {}
}

class InMemoryMessageRepository implements MessageRepository {
  constructor(readonly records: MessageRecord[]) {}

  recordAssistant(input: {
    agentRunId: string;
    content: string;
    id: string;
    now: string;
    projectId: string;
  }) {
    const existing = this.records.find(
      (message) => message.agentRunId === input.agentRunId && message.role === "assistant",
    );
    if (existing) {
      return existing;
    }

    const message: MessageRecord = {
      agentRunId: input.agentRunId,
      content: input.content,
      createdAt: input.now,
      id: input.id,
      projectId: input.projectId,
      role: "assistant",
      sequence: this.records.length,
    };
    this.records.push(message);
    return message;
  }

  async findById(messageId: string, projectId: string) {
    return (
      this.records.find((message) => message.id === messageId && message.projectId === projectId) ??
      null
    );
  }

  async listByProjectId(projectId: string) {
    return this.records.filter((message) => message.projectId === projectId);
  }
}

class InMemorySandboxLeaseRepository implements SandboxLeaseRepository {
  constructor(
    readonly lease: SandboxLeaseRecord,
    private readonly agentRuns: InMemoryAgentRunRepository,
  ) {}

  async claimIdleAfterActivityForStop(
    input: Parameters<SandboxLeaseRepository["claimIdleAfterActivityForStop"]>[0],
  ) {
    const active = await this.agentRuns.findActiveByProjectId(this.lease.projectId);
    if (
      active ||
      this.lease.id !== input.leaseId ||
      this.lease.status !== "idle" ||
      this.lease.providerRef !== input.expectedProviderRef ||
      this.lease.updatedAt !== input.expectedUpdatedAt
    ) {
      return false;
    }

    Object.assign(this.lease, {
      providerRef: null,
      status: "stopped",
      updatedAt: input.updatedAt,
    });
    return true;
  }

  async claimForManualStop(input: Parameters<SandboxLeaseRepository["claimForManualStop"]>[0]) {
    const active = await this.agentRuns.findActiveByProjectId(this.lease.projectId);
    if (
      active ||
      this.lease.id !== input.leaseId ||
      this.lease.providerRef !== input.expectedProviderRef ||
      this.lease.updatedAt !== input.expectedUpdatedAt
    ) {
      return false;
    }

    Object.assign(this.lease, {
      providerRef: null,
      status: "stopped",
      updatedAt: input.updatedAt,
    });
    return true;
  }

  async claimIdleForStop(input: Parameters<SandboxLeaseRepository["claimIdleForStop"]>[0]) {
    const active = await this.agentRuns.findActiveByProjectId(this.lease.projectId);
    const latest = this.agentRuns.latestByProject(this.lease.projectId);
    if (
      active ||
      latest?.id !== input.expectedRunId ||
      this.lease.id !== input.leaseId ||
      this.lease.status !== "idle" ||
      this.lease.providerRef !== input.expectedProviderRef ||
      this.lease.updatedAt !== input.expectedUpdatedAt
    ) {
      return false;
    }

    Object.assign(this.lease, {
      providerRef: null,
      status: "stopped",
      updatedAt: input.updatedAt,
    });
    return true;
  }

  async findByProjectId(projectId: string) {
    return this.lease.projectId === projectId ? this.lease : null;
  }

  async getOrCreate() {
    return this.lease;
  }

  async updateState(input: Parameters<SandboxLeaseRepository["updateState"]>[0]) {
    Object.assign(this.lease, {
      providerRef: input.providerRef,
      status: input.status,
      updatedAt: input.updatedAt,
    });
    return this.lease;
  }
}

class InMemoryAgentRunRepository implements AgentRunRepository {
  private readonly records = new Map<string, AgentRunRecord>();

  constructor(
    runs: AgentRunRecord[],
    private readonly messages: InMemoryMessageRepository,
  ) {
    for (const run of runs) {
      this.records.set(run.id, run);
    }
  }

  async createQueuedWithInput(): Promise<CreateQueuedAgentRunResult> {
    throw new Error("Not used by RunExecutionService tests");
  }

  async findById(agentRunId: string) {
    return this.records.get(agentRunId) ?? null;
  }

  async findActiveByProjectId(projectId: string) {
    return (
      [...this.records.values()].find(
        (run) => run.projectId === projectId && !isTerminalAgentRun(run.status),
      ) ?? null
    );
  }

  async findActiveOwnedByProjectId(projectId: string, userId: string) {
    return (
      [...this.records.values()].find(
        (run) =>
          run.projectId === projectId && run.userId === userId && !isTerminalAgentRun(run.status),
      ) ?? null
    );
  }

  async findOwnedById(agentRunId: string, userId: string) {
    const run = this.records.get(agentRunId);
    return run?.userId === userId ? run : null;
  }

  async listRecentOwnedByProjectId(projectId: string, userId: string) {
    return [...this.records.values()].filter(
      (run) => run.projectId === projectId && run.userId === userId,
    );
  }

  latestByProject(projectId: string) {
    return [...this.records.values()]
      .filter((run) => run.projectId === projectId)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      )[0];
  }

  remove(runId: string) {
    this.records.delete(runId);
  }

  async setProviderProcessRef(runId: string, providerProcessRef: string) {
    const run = this.records.get(runId);
    if (!run || isTerminalAgentRun(run.status)) {
      return null;
    }
    run.providerProcessRef = providerProcessRef;
    return run;
  }

  async setSandboxDuration(runId: string, sandboxDurationMs: number) {
    const run = this.records.get(runId);
    if (!run || isTerminalAgentRun(run.status)) {
      return null;
    }
    run.usage.sandboxDurationMs = Math.max(run.usage.sandboxDurationMs, sandboxDurationMs);
    return run;
  }

  async addUsageDelta(runId: string) {
    return this.records.get(runId) ?? null;
  }

  async completeSucceeded(input: Parameters<AgentRunRepository["completeSucceeded"]>[0]) {
    const run = this.records.get(input.runId);
    if (run?.status !== "running") {
      return null;
    }
    Object.assign(run, {
      failureCode: null,
      finishedAt: input.finishedAt,
      providerProcessRef: null,
      status: "succeeded",
    });
    run.usage.sandboxDurationMs = Math.max(run.usage.sandboxDurationMs, input.sandboxDurationMs);
    if (input.assistantMessage) {
      this.messages.recordAssistant({
        agentRunId: run.id,
        content: input.assistantMessage.content,
        id: input.assistantMessage.id,
        now: input.finishedAt,
        projectId: run.projectId,
      });
    }
    return run;
  }

  async transition(input: Parameters<AgentRunRepository["transition"]>[0]) {
    if (!canTransitionAgentRun(input.from, input.to)) {
      throw new Error(`Invalid AgentRun transition from ${input.from} to ${input.to}`);
    }
    const run = this.records.get(input.runId);
    if (!run || run.status !== input.from) {
      return null;
    }
    Object.assign(run, {
      failureCode: input.failureCode === undefined ? run.failureCode : input.failureCode,
      finishedAt: input.finishedAt === undefined ? run.finishedAt : input.finishedAt,
      startedAt: input.startedAt === undefined ? run.startedAt : input.startedAt,
      status: input.to,
    });
    if (isTerminalAgentRun(input.to)) {
      run.providerProcessRef = null;
    }
    return run;
  }
}

class MonotonicClock {
  private tick = 0;

  now() {
    const value = new Date(Date.UTC(2026, 6, 25, 0, 0, this.tick));
    this.tick += 1;
    return value;
  }
}

function createRun(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    agentRuntimeId: "pi",
    createdAt: "2026-07-25T00:00:00.000Z",
    failureCode: null,
    finishedAt: null,
    id: "run_1",
    inputMessageId: "message_1",
    modelId: "gemini-2.5-flash",
    projectId: "project_1",
    providerProcessRef: null,
    sandboxLeaseId: "lease_1",
    sandboxRuntimeId: "e2b",
    startedAt: null,
    status: "queued",
    usage: {
      inputTokens: 0,
      modelRequestCount: 0,
      outputTokens: 0,
      sandboxDurationMs: 0,
      totalTokens: 0,
    },
    userId: "user_1",
    ...overrides,
  };
}

function createLease(overrides: Partial<SandboxLeaseRecord> = {}): SandboxLeaseRecord {
  return {
    createdAt: "2026-07-25T00:00:00.000Z",
    id: "lease_1",
    projectId: "project_1",
    providerRef: null,
    runtimeId: "e2b",
    status: "stopped",
    updatedAt: "2026-07-25T00:00:00.000Z",
    ...overrides,
  };
}
