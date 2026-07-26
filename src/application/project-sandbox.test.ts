import { describe, expect, it, vi } from "vitest";

import type {
  AgentRunRecord,
  AgentRunRepository,
  SandboxLeaseRecord,
  SandboxLeaseRepository,
} from "./ports";
import { ProjectSandboxService } from "./project-sandbox";
import type { SandboxRuntime } from "../runtime/contract";

const now = new Date("2026-07-26T00:10:00.000Z");

describe("ProjectSandboxService", () => {
  it("atomically detaches and stops an idle Project sandbox", async () => {
    const lease = createLease();
    const sandboxLeases = createSandboxLeases(lease);
    const stop = vi.fn(async () => undefined);
    const service = createService({
      activeRun: null,
      sandboxLeases,
      stop,
    });

    const result = await service.stop(lease.projectId);

    expect(result).toMatchObject({
      kind: "stopped",
      lease: { providerRef: null, status: "stopped" },
    });
    expect(sandboxLeases.claimForManualStop).toHaveBeenCalledWith({
      expectedProviderRef: "provider-private-sandbox",
      expectedUpdatedAt: lease.createdAt,
      leaseId: lease.id,
      updatedAt: now.toISOString(),
    });
    expect(stop).toHaveBeenCalledWith(
      {
        id: "provider-private-sandbox",
        kind: "e2b",
        sandboxLeaseId: lease.id,
      },
      "manual",
    );
  });

  it("does not detach a sandbox while the Project has an active Run", async () => {
    const lease = createLease();
    const sandboxLeases = createSandboxLeases(lease);
    const stop = vi.fn(async () => undefined);
    const service = createService({
      activeRun: createActiveRun(lease),
      sandboxLeases,
      stop,
    });

    await expect(service.stop(lease.projectId)).resolves.toEqual({
      kind: "project_busy",
    });
    expect(sandboxLeases.claimForManualStop).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("keeps the Lease detached when the provider stop request fails", async () => {
    const lease = createLease();
    const sandboxLeases = createSandboxLeases(lease);
    const service = createService({
      activeRun: null,
      sandboxLeases,
      stop: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    });

    const result = await service.stop(lease.projectId);

    expect(result).toMatchObject({
      kind: "provider_error",
      lease: { providerRef: null, status: "stopped" },
    });
    await expect(
      sandboxLeases.findByProjectId(lease.projectId),
    ).resolves.toMatchObject({ providerRef: null, status: "stopped" });
  });
});

function createService(input: {
  activeRun: AgentRunRecord | null;
  sandboxLeases: SandboxLeaseRepository & {
    claimForManualStop: ReturnType<typeof vi.fn>;
  };
  stop: ReturnType<typeof vi.fn>;
}) {
  const agentRuns = {
    findActiveByProjectId: vi.fn(async () => input.activeRun),
  } as unknown as AgentRunRepository;
  const runtime = {
    kind: "e2b",
    stop: input.stop,
  } as unknown as SandboxRuntime;

  return new ProjectSandboxService({
    agentRuns,
    getSandboxRuntime: () => runtime,
    now: () => now,
    sandboxLeases: input.sandboxLeases,
  });
}

function createSandboxLeases(initial: SandboxLeaseRecord) {
  let lease: SandboxLeaseRecord = { ...initial };
  const claimForManualStop = vi.fn(
    async (
      input: Parameters<
        SandboxLeaseRepository["claimForManualStop"]
      >[0],
    ) => {
      if (
        lease.id !== input.leaseId ||
        lease.providerRef !== input.expectedProviderRef ||
        lease.updatedAt !== input.expectedUpdatedAt
      ) {
        return false;
      }

      lease = {
        ...lease,
        providerRef: null,
        status: "stopped",
        updatedAt: input.updatedAt,
      };
      return true;
    },
  );

  return {
    claimForManualStop,
    findByProjectId: async (projectId: string) =>
      lease.projectId === projectId ? lease : null,
  } as unknown as SandboxLeaseRepository & {
    claimForManualStop: typeof claimForManualStop;
  };
}

function createLease(): SandboxLeaseRecord {
  return {
    createdAt: "2026-07-26T00:00:00.000Z",
    id: "lease-1",
    projectId: "project-1",
    providerRef: "provider-private-sandbox",
    runtimeId: "e2b",
    status: "idle",
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
}

function createActiveRun(lease: SandboxLeaseRecord): AgentRunRecord {
  return {
    agentRuntimeId: "pi",
    createdAt: lease.createdAt,
    failureReason: null,
    finishedAt: null,
    id: "run-1",
    inputMessageId: "message-1",
    modelId: "gemini-2.5-flash",
    projectId: lease.projectId,
    providerProcessRef: null,
    sandboxLeaseId: lease.id,
    sandboxRuntimeId: lease.runtimeId,
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
