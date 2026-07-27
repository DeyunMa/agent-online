import { describe, expect, it } from "vitest";

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
      capabilitySecret: secret,
      fetchImplementation: async () =>
        Response.json({
          choices: [
            {
              finish_reason: "stop",
              index: 0,
              message: { content: "done", role: "assistant" },
            },
          ],
          usage: {
            completion_tokens: 4,
            prompt_tokens: 9,
            total_tokens: 13,
          },
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

  it("rejects a capability when its Run is terminal or does not match the Project", async () => {
    let upstreamCalls = 0;
    const run = createRun();
    run.status = "succeeded";
    const repository = new FakeModelGatewayRunRepository(run);
    const gateway = createRunAuthorizedModelGateway({
      agentRuns: repository,
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
