import { describe, expect, it, vi } from "vitest";

import type {
  AgentRunRecord,
  AgentRunRepository,
  MessageRecord,
  SandboxLeaseRecord,
  SandboxLeaseRepository,
} from "./ports";
import { CreateAgentRunService } from "./create-agent-run";

const now = "2026-07-26T08:00:00.000Z";

describe("CreateAgentRunService", () => {
  it("creates the queued facts before dispatching execution", async () => {
    const lease = sandboxLease();
    const run = agentRun();
    const start = vi.fn(async () => ({ completion: null }));
    const service = createService({
      agentRuns: agentRunRepository({
        createQueuedWithInput: async () => ({
          inputMessage: inputMessage(),
          kind: "created",
          run,
        }),
      }),
      runExecutions: { start },
      sandboxLeases: sandboxLeaseRepository({
        getOrCreate: async () => lease,
      }),
    });

    const result = await service.create({
      agentRuntimeId: "pi",
      content: "Inspect the project",
      projectId: "project-1",
      userId: "user-1",
    });

    expect(result).toMatchObject({ kind: "created", run });
    expect(start).toHaveBeenCalledWith({
      agentRun: run,
      prompt: "Inspect the project",
      sandboxLease: lease,
      workingDirectory: "/workspace",
    });
  });

  it("preserves the atomic project_busy result without dispatching", async () => {
    const start = vi.fn();
    const service = createService({
      agentRuns: agentRunRepository({
        createQueuedWithInput: async () => ({ kind: "project_busy" }),
      }),
      runExecutions: { start },
      sandboxLeases: sandboxLeaseRepository({
        getOrCreate: async () => sandboxLease(),
      }),
    });

    const result = await service.create({
      agentRuntimeId: "pi",
      content: "Inspect the project",
      projectId: "project-1",
      userId: "user-1",
    });

    expect(result).toEqual({ kind: "project_busy" });
    expect(start).not.toHaveBeenCalled();
  });

  it("converges a dispatch failure to a failed Run", async () => {
    const queued = agentRun();
    const failed: AgentRunRecord = {
      ...queued,
      failureReason: "Agent run could not be started",
      finishedAt: now,
      status: "failed",
    };
    const transition = vi.fn(async () => failed);
    const service = createService({
      agentRuns: agentRunRepository({
        createQueuedWithInput: async () => ({
          inputMessage: inputMessage(),
          kind: "created",
          run: queued,
        }),
        transition,
      }),
      runExecutions: {
        async start() {
          throw new Error("Workflow unavailable");
        },
      },
      sandboxLeases: sandboxLeaseRepository({
        getOrCreate: async () => sandboxLease(),
      }),
    });

    const result = await service.create({
      agentRuntimeId: "pi",
      content: "Inspect the project",
      projectId: "project-1",
      userId: "user-1",
    });

    expect(result).toMatchObject({
      completion: null,
      kind: "created",
      run: { status: "failed" },
    });
    expect(transition).toHaveBeenCalledWith({
      failureReason: "Agent run could not be started",
      finishedAt: now,
      from: "queued",
      runId: queued.id,
      to: "failed",
    });
  });
});

function createService(overrides: Partial<ConstructorParameters<typeof CreateAgentRunService>[0]>) {
  let id = 0;
  return new CreateAgentRunService({
    agentRuns: agentRunRepository(),
    clock: { now: () => new Date(now) },
    createId: () => `id-${++id}`,
    defaultModelId: "gemini-3.6-flash",
    runExecutions: { start: async () => ({ completion: null }) },
    sandboxLeases: sandboxLeaseRepository(),
    sandboxRuntimeId: "e2b",
    workingDirectory: "/workspace",
    ...overrides,
  });
}

function agentRunRepository(overrides: Partial<AgentRunRepository> = {}): AgentRunRepository {
  const unsupported = async () => {
    throw new Error("Unexpected AgentRunRepository call");
  };
  return {
    addUsageDelta: unsupported,
    completeSucceeded: unsupported,
    createQueuedWithInput: unsupported,
    findActiveByProjectId: unsupported,
    findActiveOwnedByProjectId: unsupported,
    findById: unsupported,
    findOwnedById: unsupported,
    listRecentOwnedByProjectId: unsupported,
    setProviderProcessRef: unsupported,
    setSandboxDuration: unsupported,
    transition: unsupported,
    ...overrides,
  } as AgentRunRepository;
}

function sandboxLeaseRepository(
  overrides: Partial<SandboxLeaseRepository> = {},
): SandboxLeaseRepository {
  const unsupported = async () => {
    throw new Error("Unexpected SandboxLeaseRepository call");
  };
  return {
    claimForManualStop: unsupported,
    claimIdleForStop: unsupported,
    findByProjectId: unsupported,
    getOrCreate: unsupported,
    updateState: unsupported,
    ...overrides,
  } as SandboxLeaseRepository;
}

function sandboxLease(): SandboxLeaseRecord {
  return {
    createdAt: now,
    id: "lease-1",
    projectId: "project-1",
    providerRef: "provider-private",
    runtimeId: "e2b",
    status: "idle",
    updatedAt: now,
  };
}

function agentRun(): AgentRunRecord {
  return {
    agentRuntimeId: "pi",
    createdAt: now,
    failureReason: null,
    finishedAt: null,
    id: "run-1",
    inputMessageId: "message-1",
    modelId: "gemini-3.6-flash",
    projectId: "project-1",
    providerProcessRef: null,
    sandboxLeaseId: "lease-1",
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
    userId: "user-1",
  };
}

function inputMessage(): MessageRecord {
  return {
    agentRunId: null,
    content: "Inspect the project",
    createdAt: now,
    id: "message-1",
    projectId: "project-1",
    role: "user",
    sequence: 0,
  };
}
