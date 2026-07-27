import { describe, expect, it } from "vitest";

import type { AgentEvent, AgentExecution, AgentRuntime } from "../agent/contract";
import { piRuntime } from "../agent/pi-runtime";
import { canTransitionAgentRun, isTerminalAgentRun } from "../domain/agent-run";
import type {
  AgentRunRecord,
  AgentRunRepository,
  MessageRecord,
  MessageRepository,
  SandboxLeaseRecord,
  SandboxLeaseRepository,
} from "./ports";
import { RunCoordinator, type Clock, type RunCoordinatorDependencies } from "./run-coordinator";
import { FakeSandboxRuntime } from "../runtime/fake-runtime";

const capabilities = {
  modelGateway: true,
  processTermination: true,
  stdin: true,
  streamingOutput: true,
  tty: false,
} as const;

describe("RunCoordinator", () => {
  it("runs Pi through SandboxRuntime and idles the lease after success", async () => {
    const fixture = createFixture();
    const coordinator = fixture.createCoordinator(piRuntime);

    const managedRun = await coordinator.start({
      agentRun: fixture.agentRunRepository.run,
      prompt: "Create a hello world app.",
      sandboxLease: fixture.sandboxLeaseRepository.lease,
      workingDirectory: "/workspace",
    });
    const completedRun = await managedRun.completion;

    expect(completedRun).toMatchObject({
      finishedAt: "2026-07-25T00:00:04.000Z",
      startedAt: "2026-07-25T00:00:00.000Z",
      status: "succeeded",
    });
    expect(
      fixture.agentRunRepository.transitions.map((transition) => [transition.from, transition.to]),
    ).toEqual([
      ["queued", "starting"],
      ["starting", "running"],
      ["running", "succeeded"],
    ]);
    expect(fixture.sandboxLeaseRepository.states.map((state) => state.status)).toEqual([
      "starting",
      "ready",
      "busy",
      "idle",
    ]);
    expect(fixture.sandboxLeaseRepository.lease).toMatchObject({
      providerRef: "fake-lease_1",
      status: "idle",
    });
  });

  it("marks a nonzero Agent completion as failed while leaving the sandbox idle", async () => {
    const fixture = createFixture();
    const coordinator = fixture.createCoordinator(completingRuntime(7));

    const managedRun = await coordinator.start(startInput(fixture));
    const completedRun = await managedRun.completion;

    expect(completedRun).toMatchObject({
      failureReason: "Agent process exited with code 7",
      status: "failed",
    });
    expect(fixture.sandboxLeaseRepository.lease.status).toBe("idle");
  });

  it("atomically persists one visible assistant reply with a successful Run", async () => {
    const fixture = createFixture();
    const coordinator = fixture.createCoordinator(completingRuntime(0, "Final visible reply"));

    const managedRun = await coordinator.start(startInput(fixture));
    const completedRun = await managedRun.completion;

    expect(completedRun.status).toBe("succeeded");
    expect(fixture.messageRepository.records).toMatchObject([
      {
        agentRunId: "run_1",
        content: "Final visible reply",
        role: "assistant",
      },
    ]);
  });

  it("lets the execution owner terminate the current Run without a process registry", async () => {
    const fixture = createFixture();
    const runtime = blockingRuntime();
    const coordinator = fixture.createCoordinator(runtime.agentRuntime);

    const managedRun = await coordinator.start(startInput(fixture));
    const cancelledRun = await managedRun.cancel("cancelled");

    expect(cancelledRun.status).toBe("cancelled");
    expect(
      fixture.agentRunRepository.transitions.map((transition) => [transition.from, transition.to]),
    ).toEqual([
      ["queued", "starting"],
      ["starting", "running"],
      ["running", "cancelling"],
      ["cancelling", "cancelled"],
    ]);
    expect(fixture.sandboxLeaseRepository.lease.status).toBe("idle");
  });

  it("observes a persisted cancellation request before completing the Run", async () => {
    const fixture = createFixture();
    const runtime = blockingRuntime();
    const coordinator = fixture.createCoordinator(runtime.agentRuntime);

    const managedRun = await coordinator.start(startInput(fixture));
    const cancellationRequest = await fixture.agentRunRepository.transition({
      from: "running",
      runId: fixture.agentRunRepository.run.id,
      to: "cancelling",
    });
    expect(cancellationRequest).toMatchObject({ status: "cancelling" });

    runtime.complete();
    const cancelledRun = await managedRun.completion;

    expect(cancelledRun.status).toBe("cancelled");
    expect(
      fixture.agentRunRepository.transitions.map((transition) => [transition.from, transition.to]),
    ).toEqual([
      ["queued", "starting"],
      ["starting", "running"],
      ["running", "cancelling"],
      ["cancelling", "cancelled"],
    ]);
    expect(fixture.sandboxLeaseRepository.lease.status).toBe("idle");
  });

  it("does not persist a reply when cancellation wins the atomic completion race", async () => {
    const fixture = createFixture();
    const runtime = blockingRuntime(0, "Reply that must not be persisted");
    const coordinator = fixture.createCoordinator(runtime.agentRuntime);
    fixture.agentRunRepository.beforeCompleteSucceeded = async () => {
      fixture.agentRunRepository.beforeCompleteSucceeded = null;
      await fixture.agentRunRepository.transition({
        from: "running",
        runId: fixture.agentRunRepository.run.id,
        to: "cancelling",
      });
    };

    const managedRun = await coordinator.start(startInput(fixture));
    runtime.complete();
    const cancelledRun = await managedRun.completion;

    expect(cancelledRun.status).toBe("cancelled");
    expect(fixture.messageRepository.records).toEqual([]);
    expect(
      fixture.agentRunRepository.transitions.map((transition) => [transition.from, transition.to]),
    ).toEqual([
      ["queued", "starting"],
      ["starting", "running"],
      ["running", "cancelling"],
      ["cancelling", "cancelled"],
    ]);
  });

  it("marks the Run and Lease failed when Agent startup fails", async () => {
    const fixture = createFixture();
    const coordinator = fixture.createCoordinator({
      capabilities,
      id: "pi",
      async start() {
        throw new Error("provider startup details must not be persisted");
      },
    });

    const managedRun = await coordinator.start(startInput(fixture));

    await expect(managedRun.completion).resolves.toMatchObject({
      failureReason: "Agent run startup failed at start_agent",
      status: "failed",
    });
    expect(fixture.sandboxLeaseRepository.lease.status).toBe("failed");
  });

  it("marks the Run and Lease failed when the Agent event stream throws", async () => {
    const fixture = createFixture();
    const coordinator = fixture.createCoordinator(failingEventRuntime());

    const managedRun = await coordinator.start(startInput(fixture));

    await expect(managedRun.completion).resolves.toMatchObject({
      failureReason: "Agent runtime failed",
      status: "failed",
    });
    expect(fixture.sandboxLeaseRepository.lease.status).toBe("failed");
  });
});

function startInput(fixture: ReturnType<typeof createFixture>) {
  return {
    agentRun: fixture.agentRunRepository.run,
    prompt: "Make a change.",
    sandboxLease: fixture.sandboxLeaseRepository.lease,
    workingDirectory: "/workspace",
  };
}

function createFixture() {
  const messageRepository = new FakeMessageRepository();
  const agentRunRepository = new FakeAgentRunRepository(createAgentRun(), messageRepository);
  const sandboxLeaseRepository = new FakeSandboxLeaseRepository(createSandboxLease());
  const sandboxRuntime = new FakeSandboxRuntime();

  return {
    agentRunRepository,
    createCoordinator(agentRuntime: AgentRuntime) {
      const dependencies: RunCoordinatorDependencies = {
        agentRunRepository,
        clock: new SequenceClock(),
        createId: () => "assistant_message_1",
        getAgentRuntime: () => agentRuntime,
        getSandboxRuntime: () => sandboxRuntime,
        sandboxLeaseRepository,
      };
      return new RunCoordinator(dependencies);
    },
    messageRepository,
    sandboxLeaseRepository,
  };
}

function createAgentRun(): AgentRunRecord {
  return {
    agentRuntimeId: "pi",
    createdAt: "2026-07-25T00:00:00.000Z",
    failureReason: null,
    finishedAt: null,
    id: "run_1",
    inputMessageId: "message_1",
    modelId: "gemini-2.5-flash",
    projectId: "project_1",
    providerProcessRef: null,
    sandboxLeaseId: "lease_1",
    sandboxRuntimeId: "fake",
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
  };
}

function createSandboxLease(): SandboxLeaseRecord {
  return {
    createdAt: "2026-07-25T00:00:00.000Z",
    id: "lease_1",
    projectId: "project_1",
    providerRef: null,
    runtimeId: "fake",
    status: "stopped",
    updatedAt: "2026-07-25T00:00:00.000Z",
  };
}

function completingRuntime(exitCode: number, finalText: string | null = null): AgentRuntime {
  return {
    capabilities,
    id: "pi",
    async start(context, input): Promise<AgentExecution> {
      const process = await context.processes.start({
        agentRunId: input.agentRunId,
        args: [],
        command: "pi",
        cwd: input.workingDirectory,
      });

      return {
        async cancel() {},
        async *events() {
          yield startedEvent(input);
          yield completedEvent(input, exitCode, finalText);
        },
        providerProcessRef: process.providerProcessRef,
      };
    },
  };
}

function blockingRuntime(exitCode = 143, finalText: string | null = null) {
  let releaseEvents: () => void = () => undefined;
  const release = new Promise<void>((resolve) => {
    releaseEvents = resolve;
  });

  return {
    agentRuntime: {
      capabilities,
      id: "pi" as const,
      async start(context, input): Promise<AgentExecution> {
        const process = await context.processes.start({
          agentRunId: input.agentRunId,
          args: [],
          command: "pi",
          cwd: input.workingDirectory,
        });

        return {
          async cancel() {},
          async *events() {
            yield startedEvent(input);
            await release;
            yield completedEvent(input, exitCode, finalText);
          },
          providerProcessRef: process.providerProcessRef,
        };
      },
    } satisfies AgentRuntime,
    complete: () => releaseEvents(),
  };
}

function failingEventRuntime(): AgentRuntime {
  return {
    capabilities,
    id: "pi",
    async start(_context, input): Promise<AgentExecution> {
      return {
        async cancel() {},
        async *events() {
          yield startedEvent(input);
          throw new Error("event stream failure");
        },
        providerProcessRef: "process_1",
      };
    },
  };
}

function startedEvent(input: { agentRunId: string; sandboxLeaseId: string }): AgentEvent {
  return {
    agentRuntimeId: "pi",
    agentRunId: input.agentRunId,
    sandboxLeaseId: input.sandboxLeaseId,
    type: "agent.started",
  };
}

function completedEvent(
  input: { agentRunId: string; sandboxLeaseId: string },
  exitCode: number,
  finalText: string | null = null,
): AgentEvent {
  return {
    agentRuntimeId: "pi",
    agentRunId: input.agentRunId,
    exitCode,
    finalText,
    sandboxLeaseId: input.sandboxLeaseId,
    type: "agent.completed",
  };
}

class SequenceClock implements Clock {
  private index = 0;
  private readonly timestamps = [
    "2026-07-25T00:00:00.000Z",
    "2026-07-25T00:00:01.000Z",
    "2026-07-25T00:00:02.000Z",
    "2026-07-25T00:00:03.000Z",
    "2026-07-25T00:00:04.000Z",
  ];

  now() {
    const timestamp = this.timestamps[Math.min(this.index, this.timestamps.length - 1)];
    this.index += 1;
    return new Date(timestamp);
  }
}

class FakeAgentRunRepository implements AgentRunRepository {
  readonly transitions: Array<Parameters<AgentRunRepository["transition"]>[0]> = [];
  beforeCompleteSucceeded: (() => Promise<void> | void) | null = null;

  constructor(
    readonly run: AgentRunRecord,
    private readonly messages: FakeMessageRepository,
  ) {}

  async createQueuedWithInput(
    _input: Parameters<AgentRunRepository["createQueuedWithInput"]>[0],
  ): Promise<never> {
    throw new Error("Not used by RunCoordinator tests");
  }

  async findById(agentRunId: string) {
    return this.run.id === agentRunId ? this.run : null;
  }

  async findActiveByProjectId(projectId: string) {
    return this.run.projectId === projectId && !isTerminalAgentRun(this.run.status)
      ? this.run
      : null;
  }

  async findActiveOwnedByProjectId(projectId: string, userId: string) {
    return this.run.projectId === projectId &&
      this.run.userId === userId &&
      !isTerminalAgentRun(this.run.status)
      ? this.run
      : null;
  }

  async findOwnedById(agentRunId: string, userId: string) {
    return this.run.id === agentRunId && this.run.userId === userId ? this.run : null;
  }

  async listRecentOwnedByProjectId(projectId: string, userId: string) {
    return this.run.projectId === projectId && this.run.userId === userId ? [this.run] : [];
  }

  async setProviderProcessRef(runId: string, providerProcessRef: string) {
    if (this.run.id !== runId || isTerminalAgentRun(this.run.status)) {
      return null;
    }

    this.run.providerProcessRef = providerProcessRef;
    return this.run;
  }

  async setSandboxDuration(_runId: string, sandboxDurationMs: number) {
    this.run.usage.sandboxDurationMs = Math.max(
      this.run.usage.sandboxDurationMs,
      sandboxDurationMs,
    );
    return this.run;
  }

  async addUsageDelta() {
    return this.run;
  }

  async completeSucceeded(input: Parameters<AgentRunRepository["completeSucceeded"]>[0]) {
    await this.beforeCompleteSucceeded?.();
    if (this.run.id !== input.runId || this.run.status !== "running") {
      return null;
    }

    this.transitions.push({
      failureReason: null,
      finishedAt: input.finishedAt,
      from: "running",
      runId: input.runId,
      to: "succeeded",
    });
    Object.assign(this.run, {
      failureReason: null,
      finishedAt: input.finishedAt,
      providerProcessRef: null,
      status: "succeeded",
    });
    this.run.usage.sandboxDurationMs = Math.max(
      this.run.usage.sandboxDurationMs,
      input.sandboxDurationMs,
    );
    if (input.assistantMessage) {
      this.messages.recordAssistant({
        agentRunId: this.run.id,
        content: input.assistantMessage.content,
        id: input.assistantMessage.id,
        now: input.finishedAt,
        projectId: this.run.projectId,
      });
    }
    return this.run;
  }

  async transition(input: Parameters<AgentRunRepository["transition"]>[0]) {
    if (!canTransitionAgentRun(input.from, input.to)) {
      throw new Error(`Invalid AgentRun transition from ${input.from} to ${input.to}`);
    }
    this.transitions.push(input);
    if (this.run.status !== input.from) {
      return null;
    }

    Object.assign(this.run, {
      failureReason: input.failureReason ?? this.run.failureReason,
      finishedAt: input.finishedAt ?? this.run.finishedAt,
      startedAt: input.startedAt ?? this.run.startedAt,
      status: input.to,
    });
    if (isTerminalAgentRun(input.to)) {
      this.run.providerProcessRef = null;
    }
    return this.run;
  }
}

class FakeMessageRepository implements MessageRepository {
  readonly records: MessageRecord[] = [];

  recordAssistant(input: {
    agentRunId: string;
    content: string;
    id: string;
    now: string;
    projectId: string;
  }) {
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

class FakeSandboxLeaseRepository implements SandboxLeaseRepository {
  readonly states: Array<Parameters<SandboxLeaseRepository["updateState"]>[0]> = [];

  constructor(readonly lease: SandboxLeaseRecord) {}

  async claimIdleAfterActivityForStop(
    input: Parameters<SandboxLeaseRepository["claimIdleAfterActivityForStop"]>[0],
  ) {
    if (
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
    if (
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
    if (
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
    this.states.push(input);
    Object.assign(this.lease, {
      providerRef: input.providerRef,
      status: input.status,
      updatedAt: input.updatedAt,
    });
    return this.lease;
  }
}
