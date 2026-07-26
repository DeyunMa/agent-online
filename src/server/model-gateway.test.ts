import { describe, expect, it } from "vitest";

import { createOpenAiCompatibleModelGateway, type ModelGatewayUsage } from "./model-gateway";

const modelId = "gemini-2.5-flash";

describe("OpenAI-compatible ModelGateway", () => {
  it("keeps the Gemini key on the gateway and returns Pi-compatible SSE with actual usage", async () => {
    const recordedUsage: ModelGatewayUsage[] = [];
    let fetchCallCount = 0;
    const capturedRequests: Array<{ init?: RequestInit; input: RequestInfo | URL }> = [];
    const fetchImplementation: typeof fetch = async (input, init) => {
      fetchCallCount += 1;
      capturedRequests.push({ init, input });

      return Response.json({
        candidates: [{ content: { parts: [{ text: "AGENT_ONLINE_E2E_OK" }] } }],
        usageMetadata: {
          candidatesTokenCount: 4,
          promptTokenCount: 9,
          totalTokenCount: 13,
        },
      });
    };
    const gateway = createOpenAiCompatibleModelGateway({
      async authorize(request) {
        return request.headers.get("authorization") === "Bearer spike-capability"
          ? { maxOutputTokens: 128, modelId, projectId: "project-1", runId: "run-1" }
          : null;
      },
      fetchImplementation,
      geminiApiKey: "test-gemini-key",
      onUsage: (usage) => {
        recordedUsage.push(usage);
      },
    });

    const response = await gateway(new Request("https://gateway.test/v1/chat/completions", {
      body: JSON.stringify({
        messages: [
          { content: "You are a terse coding assistant.", role: "developer" },
          { content: "Return the test marker.", role: "user" },
        ],
        model: modelId,
        stream: true,
      }),
      headers: { authorization: "Bearer spike-capability", "content-type": "application/json" },
      method: "POST",
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const responseBody = await response.text();
    expect(responseBody).toContain("AGENT_ONLINE_E2E_OK");
    expect(responseBody).toContain("[DONE]");
    expect(fetchCallCount).toBe(1);
    const capturedRequest = capturedRequests[0];
    if (!capturedRequest) {
      throw new Error("Expected the ModelGateway to call Gemini once.");
    }
    expect(String(capturedRequest?.input)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(capturedRequest.init).toMatchObject({
      headers: expect.objectContaining({ "x-goog-api-key": "test-gemini-key" }),
      method: "POST",
    });

    expect(JSON.parse(String(capturedRequest.init?.body))).toEqual({
      contents: [{ parts: [{ text: "Return the test marker." }], role: "user" }],
      generationConfig: { maxOutputTokens: 128 },
      systemInstruction: { parts: [{ text: "You are a terse coding assistant." }] },
    });
    expect(recordedUsage).toEqual([{ inputTokens: 9, modelRequestCount: 1, outputTokens: 4, totalTokens: 13 }]);
  });

  it("rejects invalid capabilities before calling Gemini", async () => {
    let fetchCallCount = 0;
    const fetchImplementation: typeof fetch = async () => {
      fetchCallCount += 1;
      return Response.json({});
    };
    const gateway = createOpenAiCompatibleModelGateway({
      async authorize() {
        return null;
      },
      fetchImplementation,
      geminiApiKey: "test-gemini-key",
    });

    const response = await gateway(new Request("https://gateway.test/v1/chat/completions", {
      body: JSON.stringify({ messages: [{ content: "Hello", role: "user" }], model: modelId, stream: true }),
      method: "POST",
    }));

    expect(response.status).toBe(401);
    expect(fetchCallCount).toBe(0);
  });

  it("binds the capability to one model", async () => {
    let fetchCallCount = 0;
    const fetchImplementation: typeof fetch = async () => {
      fetchCallCount += 1;
      return Response.json({});
    };
    const gateway = createOpenAiCompatibleModelGateway({
      async authorize() {
        return { maxOutputTokens: 128, modelId, projectId: "project-1", runId: "run-1" };
      },
      fetchImplementation,
      geminiApiKey: "test-gemini-key",
    });

    const response = await gateway(new Request("https://gateway.test/v1/chat/completions", {
      body: JSON.stringify({ messages: [{ content: "Hello", role: "user" }], model: "another-model", stream: true }),
      method: "POST",
    }));

    expect(response.status).toBe(403);
    expect(fetchCallCount).toBe(0);
  });
});
