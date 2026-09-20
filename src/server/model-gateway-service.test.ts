import { describe, expect, it, vi } from "vitest";

import type { AgentRunRecord, AgentRunUsageDelta } from "../application/ports";
import { createRunAuthorizedModelGateway, modelGatewayEndpointPath } from "./model-gateway-service";
import { createRunCapabilityCodec } from "./run-capability";

const secret = "test-secret-with-at-least-thirty-two-characters";
const now = new Date("2026-07-26T00:01:00.000Z");

describe("Run-authorized ModelGateway", () => {
  it("authorizes one active Run and atomically records upstream usage", async () => {
    const repository = new FakeModelGatewayRunRepository(createRun());
    const gateway = createRunAuthorizedModelGateway({
      agentRuns: repository,
      modelAdmission: { acquire: async () => true, release: async () => {} },
      capabilitySecret: secret,
      fetchImplementation: async () =>
        Response.json({
          candidates: [
            { content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" },
          ],
          usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 },
        }),
      geminiApiKey: "test-gemini-key",
      now: () => now,
    });
    const token = await issueCapability();

    const response = await gateway(createCompletionRequest(token));

    expect(response.status).toBe(200);
    expect(repository.usageDeltas).toEqual([
      {
        inputTokens: 9,
        modelRequestCount: 1,
        outputTokens: 4,
        sandboxDurationMs: 0,
        totalTokens: 13,
      },
    ]);
  });

  it("rejects exhausted allowance before contacting the model", async () => {
    const fetchImplementation = vi.fn();
    const modelAdmission = { acquire: vi.fn(async () => false), release: vi.fn(async () => {}) };
    const gateway = createRunAuthorizedModelGateway({
      agentRuns: new FakeModelGatewayRunRepository(createRun()),
      capabilitySecret: secret,
      geminiApiKey: "test-key",
      now: () => now,
      modelAdmission,
      fetchImplementation,
    });
    const response = await gateway(createCompletionRequest(await issueCapability()));
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: "resource_limit" } });
    expect(modelAdmission.acquire).toHaveBeenCalledWith("run-1");
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(modelAdmission.release).not.toHaveBeenCalled();
  });

  it("fails closed when admission persistence is unavailable", async () => {
    const fetchImplementation = vi.fn();
    const gateway = createRunAuthorizedModelGateway({
      agentRuns: new FakeModelGatewayRunRepository(createRun()),
      capabilitySecret: secret,
      geminiApiKey: "test-key",
      now: () => now,
      modelAdmission: {
        acquire: async () => {
          throw new Error("private DB details");
        },
        release: async () => {},
      },
      fetchImplementation,
    });
    const response = await gateway(createCompletionRequest(await issueCapability()));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("holds the model permit through usage persistence and releases on failure", async () => {
    let releaseUpstream: ((response: Response) => void) | undefined;
    let occupied = false;
    const modelAdmission = {
      acquire: vi.fn(async () => {
        if (occupied) return false;
        occupied = true;
        return true;
      }),
      release: vi.fn(async () => {
        occupied = false;
      }),
    };
    const repository = new FakeModelGatewayRunRepository(createRun());
    const writeUsage = vi.spyOn(repository, "addUsageDelta").mockImplementation(async () => {
      expect(occupied).toBe(true);
      throw new Error("private persistence error");
    });
    const fetchImplementation = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseUpstream = resolve;
        }),
    );
    const gateway = createRunAuthorizedModelGateway({
      agentRuns: repository,
      capabilitySecret: secret,
      geminiApiKey: "test-key",
      now: () => now,
      modelAdmission,
      fetchImplementation,
    });
    const token = await issueCapability();
    const first = gateway(createCompletionRequest(token));
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(1));
    expect((await gateway(createCompletionRequest(token))).status).toBe(429);
    releaseUpstream?.(
      Response.json({
        candidates: [
          { content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      }),
    );
    const response = await first;
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private");
    expect(writeUsage).toHaveBeenCalledOnce();
    expect(modelAdmission.release).toHaveBeenCalledOnce();
    expect(occupied).toBe(false);
  });

  it("releases an admitted request after upstream network failure without refunding it", async () => {
    const modelAdmission = { acquire: vi.fn(async () => true), release: vi.fn(async () => {}) };
    const gateway = createRunAuthorizedModelGateway({
      agentRuns: new FakeModelGatewayRunRepository(createRun()),
      capabilitySecret: secret,
      geminiApiKey: "test-key",
      now: () => now,
      modelAdmission,
      fetchImplementation: async () => {
        throw new Error("upstream unreachable");
      },
    });
    expect((await gateway(createCompletionRequest(await issueCapability()))).status).toBe(502);
    expect(modelAdmission.acquire).toHaveBeenCalledOnce();
    expect(modelAdmission.release).toHaveBeenCalledWith("run-1");
  });

  it("rejects a capability when its Run is terminal or does not match the Project", async () => {
    let upstreamCalls = 0;
    const run = createRun();
    run.status = "succeeded";
    const repository = new FakeModelGatewayRunRepository(run);
    const gateway = createRunAuthorizedModelGateway({
      agentRuns: repository,
      modelAdmission: { acquire: async () => true, release: async () => {} },
      capabilitySecret: secret,
      fetchImplementation: async () => {
        upstreamCalls += 1;
        return Response.json({});
      },
      geminiApiKey: "test-gemini-key",
      now: () => now,
    });

    const terminalResponse = await gateway(createCompletionRequest(await issueCapability()));
    run.status = "running";
    run.projectId = "another-project";
    const mismatchedResponse = await gateway(createCompletionRequest(await issueCapability()));

    expect(terminalResponse.status).toBe(401);
    expect(mismatchedResponse.status).toBe(401);
    expect(upstreamCalls).toBe(0);
    expect(repository.usageDeltas).toHaveLength(0);
  });
});

class FakeModelGatewayRunRepository {
  readonly usageDeltas: AgentRunUsageDelta[] = [];

  constructor(private readonly run: AgentRunRecord) {}

  async findById(runId: string) {
    return this.run.id === runId ? this.run : null;
  }

  async addUsageDelta(runId: string, usage: AgentRunUsageDelta) {
    if (
      this.run.id !== runId ||
      (this.run.status !== "starting" && this.run.status !== "running")
    ) {
      return null;
    }

    this.usageDeltas.push(usage);
    return this.run;
  }
}

async function issueCapability() {
  return createRunCapabilityCodec({
    now: () => now,
    secret,
  }).issue({
    expiresAt: new Date("2026-07-26T00:05:00.000Z"),
    issuedAt: new Date("2026-07-26T00:00:00.000Z"),
    maxOutputTokens: 128,
    modelId: "gemini-2.5-flash",
    projectId: "project-1",
    runId: "run-1",
  });
}

function createCompletionRequest(token: string) {
  return new Request(`https://agent-online.test${modelGatewayEndpointPath}`, {
    body: JSON.stringify({
      messages: [{ content: "hello", role: "user" }],
      model: "gemini-2.5-flash",
      stream: false,
    }),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
}

function createRun(): AgentRunRecord {
  return {
    agentRuntimeId: "pi",
    createdAt: "2026-07-26T00:00:00.000Z",
    failureCode: null,
    finishedAt: null,
    id: "run-1",
    inputMessageId: "message-1",
    modelId: "gemini-2.5-flash",
    projectId: "project-1",
    providerProcessRef: "42",
    sandboxLeaseId: "lease-1",
    sandboxRuntimeId: "e2b",
    startedAt: "2026-07-26T00:00:01.000Z",
    status: "running",
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
