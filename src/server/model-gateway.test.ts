import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenAiCompatibleModelGateway, type ModelGatewayUsage } from "./model-gateway";

const modelId = "gemini-2.5-flash";

describe("OpenAI-compatible ModelGateway", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the Gemini key on the gateway and proxies Pi tools with actual streaming usage", async () => {
    const recordedUsage: ModelGatewayUsage[] = [];
    let fetchCallCount = 0;
    const capturedRequests: Array<{ init?: RequestInit; input: RequestInfo | URL }> = [];
    const fetchImplementation: typeof fetch = async (input, init) => {
      fetchCallCount += 1;
      capturedRequests.push({ init, input });

      return new Response(
        [
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      extra_content: {
                        google: {
                          thought_signature: "signed-test-thought",
                        },
                      },
                      function: { arguments: '{"path":"/workspace/test.txt"}', name: "write_file" },
                      id: "call-1",
                      index: 0,
                      type: "function",
                    },
                  ],
                },
                finish_reason: null,
                index: 0,
              },
            ],
          })}`,
          `data: ${JSON.stringify({
            choices: [
              {
                delta: { role: "assistant" },
                finish_reason: "stop",
                index: 0,
              },
            ],
          })}`,
          `data: ${JSON.stringify({
            choices: [],
            usage: {
              completion_tokens: 4,
              prompt_tokens: 9,
              total_tokens: 13,
            },
          })}`,
          "data: [DONE]",
          "",
        ].join("\n\n"),
        {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
          },
        },
      );
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

    const response = await gateway(
      new Request("https://gateway.test/v1/chat/completions", {
        body: JSON.stringify({
          messages: [
            { content: "You are a terse coding assistant.", role: "developer" },
            { content: "Return the test marker.", role: "user" },
          ],
          model: modelId,
          stream: true,
          tool_choice: "auto",
          tools: [
            {
              function: {
                description: "Write a file",
                name: "write_file",
                parameters: {
                  properties: { path: { type: "string" } },
                  required: ["path"],
                  type: "object",
                },
              },
              type: "function",
            },
          ],
        }),
        headers: { authorization: "Bearer spike-capability", "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const responseBody = await response.text();
    expect(responseBody).toContain("write_file");
    expect(responseBody).toContain('"finish_reason":"tool_calls"');
    expect(responseBody).toContain('"reasoning_details"');
    expect(responseBody).toContain("signed-test-thought");
    expect(responseBody).toContain("[DONE]");
    expect(fetchCallCount).toBe(1);
    const capturedRequest = capturedRequests[0];
    if (!capturedRequest) {
      throw new Error("Expected the ModelGateway to call Gemini once.");
    }
    expect(String(capturedRequest?.input)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    expect(capturedRequest.init).toMatchObject({
      headers: expect.objectContaining({ authorization: "Bearer test-gemini-key" }),
      method: "POST",
    });

    expect(JSON.parse(String(capturedRequest.init?.body))).toEqual({
      max_tokens: 128,
      messages: [
        { content: "You are a terse coding assistant.", role: "developer" },
        { content: "Return the test marker.", role: "user" },
      ],
      model: modelId,
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: "auto",
      tools: [
        {
          function: {
            description: "Write a file",
            name: "write_file",
            parameters: {
              properties: { path: { type: "string" } },
              required: ["path"],
              type: "object",
            },
          },
          type: "function",
        },
      ],
    });
    expect(recordedUsage).toEqual([
      { inputTokens: 9, modelRequestCount: 1, outputTokens: 4, totalTokens: 13 },
    ]);
  });

  it("returns Pi reasoning details to Gemini as a tool-call thought signature", async () => {
    let upstreamBodyText = "";
    const gateway = createOpenAiCompatibleModelGateway({
      async authorize() {
        return { maxOutputTokens: 128, modelId, projectId: "project-1", runId: "run-1" };
      },
      fetchImplementation: async (_input, init) => {
        upstreamBodyText = String(init?.body);
        return Response.json({
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
        });
      },
      geminiApiKey: "test-gemini-key",
    });

    const response = await gateway(
      new Request("https://gateway.test/v1/chat/completions", {
        body: JSON.stringify({
          messages: [
            { content: "Read the file.", role: "user" },
            {
              content: null,
              reasoning_details: [
                {
                  data: "signed-test-thought",
                  id: "call-1",
                  type: "reasoning.encrypted",
                },
              ],
              role: "assistant",
              tool_calls: [
                {
                  function: { arguments: '{"path":"/workspace/test.txt"}', name: "read_file" },
                  id: "call-1",
                  type: "function",
                },
              ],
            },
            { content: "OK", role: "tool", tool_call_id: "call-1" },
          ],
          model: modelId,
          stream: false,
          tools: [],
        }),
        headers: {
          authorization: "Bearer spike-capability",
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    const upstreamBody = JSON.parse(upstreamBodyText) as Record<string, unknown>;
    const messages = upstreamBody.messages;
    expect(Array.isArray(messages)).toBe(true);
    const assistantMessage = Array.isArray(messages) ? messages[1] : null;
    expect(assistantMessage).not.toHaveProperty("reasoning_details");
    expect(assistantMessage).toMatchObject({
      tool_calls: [
        {
          extra_content: {
            google: {
              thought_signature: "signed-test-thought",
            },
          },
          id: "call-1",
        },
      ],
    });
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

    const response = await gateway(
      new Request("https://gateway.test/v1/chat/completions", {
        body: JSON.stringify({
          messages: [{ content: "Hello", role: "user" }],
          model: modelId,
          stream: true,
        }),
        method: "POST",
      }),
    );

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

    const response = await gateway(
      new Request("https://gateway.test/v1/chat/completions", {
        body: JSON.stringify({
          messages: [{ content: "Hello", role: "user" }],
          model: "another-model",
          stream: true,
        }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(403);
    expect(fetchCallCount).toBe(0);
  });

  it("rejects completion requests above the gateway byte limit", async () => {
    let fetchCallCount = 0;
    const gateway = createOpenAiCompatibleModelGateway({
      async authorize() {
        return {
          maxOutputTokens: 128,
          modelId,
          projectId: "project-1",
          runId: "run-1",
        };
      },
      fetchImplementation: async () => {
        fetchCallCount += 1;
        return Response.json({});
      },
      geminiApiKey: "test-gemini-key",
    });

    const response = await gateway(
      new Request("https://gateway.test/v1/chat/completions", {
        body: "{}",
        headers: {
          "content-length": String(4 * 1_024 * 1_024 + 1),
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(413);
    expect(fetchCallCount).toBe(0);
  });

  it("enforces the request byte limit without a Content-Length header", async () => {
    let fetchCallCount = 0;
    const gateway = createOpenAiCompatibleModelGateway({
      async authorize() {
        return {
          maxOutputTokens: 128,
          modelId,
          projectId: "project-1",
          runId: "run-1",
        };
      },
      fetchImplementation: async () => {
        fetchCallCount += 1;
        return Response.json({});
      },
      geminiApiKey: "test-gemini-key",
    });

    const response = await gateway(
      new Request("https://gateway.test/v1/chat/completions", {
        body: "x".repeat(4 * 1_024 * 1_024 + 1),
        method: "POST",
      }),
    );

    expect(response.status).toBe(413);
    expect(fetchCallCount).toBe(0);
  });

  it("rejects an oversized buffered upstream response", async () => {
    const gateway = createOpenAiCompatibleModelGateway({
      async authorize() {
        return {
          maxOutputTokens: 128,
          modelId,
          projectId: "project-1",
          runId: "run-1",
        };
      },
      fetchImplementation: async () => new Response("x".repeat(8 * 1_024 * 1_024 + 1)),
      geminiApiKey: "test-gemini-key",
    });

    const response = await gateway(
      new Request("https://gateway.test/v1/chat/completions", {
        body: JSON.stringify({
          messages: [{ content: "Hello", role: "user" }],
          model: modelId,
          stream: true,
        }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(502);
  });

  it("bounds upstream error diagnostics without logging response content", async () => {
    const report = vi.fn();
    const gateway = createOpenAiCompatibleModelGateway({
      async authorize() {
        return {
          maxOutputTokens: 128,
          modelId,
          projectId: "project-1",
          runId: "run-1",
        };
      },
      fetchImplementation: async () =>
        new Response("private-upstream-body".repeat(4_096), {
          status: 429,
        }),
      diagnostics: { report },
      geminiApiKey: "test-gemini-key",
    });

    const response = await gateway(
      new Request("https://gateway.test/v1/chat/completions", {
        body: JSON.stringify({
          messages: [{ content: "Hello", role: "user" }],
          model: modelId,
          stream: true,
        }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(502);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "MODEL_UPSTREAM_REJECTED",
        event: "model_gateway.request_failed",
        runId: "run-1",
        upstreamHttpStatus: 429,
      }),
    );
    expect(JSON.stringify(report.mock.calls)).not.toContain("private-upstream-body");
  });
});
