import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenAiCompatibleModelGateway, type ModelGatewayUsage } from "./model-gateway";

const modelId = "gemini-2.5-flash";

const plainRequest = (stream = false, extra: Record<string, unknown> = {}) =>
  new Request("https://gateway.test/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "Hello" }],
      stream,
      ...extra,
    }),
  });
const authorize = async () => ({
  modelId,
  maxOutputTokens: 128,
  projectId: "project-1",
  runId: "run-1",
});
const nativeReply = (usage: Record<string, unknown> | undefined) => ({
  candidates: [
    {
      content: {
        role: "model",
        parts: [{ text: "PRIVATE REASONING", thought: true }, { text: "done" }],
      },
      finishReason: "STOP",
    },
  ],
  ...(usage ? { usageMetadata: usage } : {}),
});

describe("OpenAI-compatible ModelGateway", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "rejects undeclared tool calls without recording success (stream=%s)",
    async (stream) => {
      const reply = {
        candidates: [
          {
            content: { role: "model", parts: [{ functionCall: { name: "undeclared", args: {} } }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      };
      const onUsage = vi.fn();
      const gateway = createOpenAiCompatibleModelGateway({
        authorize,
        geminiApiKey: "test-key",
        onUsage,
        fetchImplementation: async () =>
          stream
            ? new Response(`data: ${JSON.stringify(reply)}\n\n`, {
                headers: { "content-type": "text/event-stream" },
              })
            : Response.json(reply),
      });
      expect((await gateway(plainRequest(stream))).status).toBe(502);
      expect(onUsage).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "preserves measured usage semantics without disclosing reasoning (stream=%s)",
    async (stream) => {
      const onUsage = vi.fn();
      const reply = nativeReply({
        promptTokenCount: 9,
        candidatesTokenCount: 4,
        thoughtsTokenCount: 3,
        totalTokenCount: 16,
      });
      const gateway = createOpenAiCompatibleModelGateway({
        authorize,
        geminiApiKey: "test-key",
        onUsage,
        fetchImplementation: async () =>
          stream
            ? new Response(`data: ${JSON.stringify(reply)}\n\n`, {
                headers: { "content-type": "text/event-stream" },
              })
            : Response.json(reply),
      });
      const response = await gateway(plainRequest(stream));
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain("PRIVATE REASONING");
      expect(onUsage).toHaveBeenCalledWith(
        { inputTokens: 9, outputTokens: 4, totalTokens: 16, modelRequestCount: 1 },
        expect.anything(),
      );
    },
  );

  it.each([
    undefined,
    {},
    { promptTokenCount: 1 },
    { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 1 },
  ])("fails closed on absent or invalid actual usage %j", async (usage) => {
    const onUsage = vi.fn();
    const gateway = createOpenAiCompatibleModelGateway({
      authorize,
      geminiApiKey: "test-key",
      onUsage,
      fetchImplementation: async () => Response.json(nativeReply(usage)),
    });
    expect((await gateway(plainRequest())).status).toBe(502);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it.each([429, 500, 302])(
    "never retries or follows a provider rejection (%s), or leaks its details",
    async (status) => {
      const fetchImplementation = vi.fn(
        async () =>
          new Response("PRIVATE UPSTREAM", {
            status,
            headers: { Location: "https://attacker.test" },
          }),
      );
      const report = vi.fn();
      const gateway = createOpenAiCompatibleModelGateway({
        authorize,
        geminiApiKey: "test-key",
        fetchImplementation,
        diagnostics: { report },
      });
      const response = await gateway(plainRequest(true));
      expect(response.status).toBe(502);
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
      expect(await response.text()).not.toContain("PRIVATE");
      expect(JSON.stringify(report.mock.calls)).not.toContain("PRIVATE");
    },
  );

  it("rejects malformed tool history and remote media before consuming admission or fetching", async () => {
    const fetchImplementation = vi.fn();
    const admit = vi.fn();
    const gateway = createOpenAiCompatibleModelGateway({
      authorize,
      geminiApiKey: "test-key",
      fetchImplementation,
      admit,
    });
    for (const messages of [
      [{ role: "tool", tool_call_id: "missing", content: "x" }],
      [
        {
          role: "assistant",
          tool_calls: [
            { type: "function", id: "call", function: { name: "test", arguments: "bad-json" } },
          ],
        },
      ],
      [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "http://127.0.0.1/private" } }],
        },
      ],
    ])
      expect((await gateway(plainRequest(false, { messages }))).status).toBe(400);
    expect(admit).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("cancels one in-flight SDK call and releases admission without retrying", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const release = vi.fn(async () => {});
    const fetchImplementation = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          started();
          init?.signal?.addEventListener("abort", () => reject(new Error("test abort")), {
            once: true,
          });
        }),
    );
    const gateway = createOpenAiCompatibleModelGateway({
      authorize,
      geminiApiKey: "test-key",
      fetchImplementation,
      admit: async () => ({ release }),
    });
    const pending = gateway(new Request(plainRequest(true), { signal: controller.signal }));
    await ready;
    controller.abort();
    expect((await pending).status).toBe(502);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("keeps the Gemini key on the gateway and proxies Pi tools with actual streaming usage", async () => {
    const recordedUsage: ModelGatewayUsage[] = [];
    let fetchCallCount = 0;
    const capturedRequests: Array<{
      init: RequestInit | undefined;
      input: RequestInfo | URL;
    }> = [];
    const fetchImplementation: typeof fetch = async (input, init) => {
      fetchCallCount += 1;
      capturedRequests.push({ init, input });

      return new Response(
        [
          {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [
                    {
                      functionCall: { name: "write_file", args: { path: "/workspace/test.txt" } },
                      thoughtSignature: "signed-test-thought",
                    },
                  ],
                },
              },
            ],
          },
          {
            candidates: [{ finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 },
          },
        ]
          .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
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
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
    );
    expect(capturedRequest.init).toMatchObject({
      headers: expect.objectContaining({ "x-goog-api-key": "test-gemini-key" }),
      method: "POST",
    });

    expect(JSON.parse(String(capturedRequest.init?.body))).toMatchObject({
      generationConfig: { maxOutputTokens: 128 },
      systemInstruction: { parts: [{ text: "You are a terse coding assistant." }] },
      contents: [{ role: "user", parts: [{ text: "Return the test marker." }] }],
      tools: [{ functionDeclarations: [{ name: "write_file" }] }],
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
          candidates: [
            { content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" },
          ],
          usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 },
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
    expect(upstreamBody.contents).toMatchObject([
      { role: "user" },
      {
        role: "model",
        parts: [
          {
            functionCall: { name: "read_file", args: { path: "/workspace/test.txt" } },
            thoughtSignature: "signed-test-thought",
          },
        ],
      },
      { role: "user", parts: [{ functionResponse: { name: "read_file" } }] },
    ]);
    expect(upstreamBodyText).not.toContain("reasoning_details");
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

  it("bounds an upstream model request with an explicit deadline", async () => {
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
      diagnostics: { report },
      fetchImplementation: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("Expected the gateway to provide an abort signal."));
            return;
          }
          if (signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      geminiApiKey: "test-gemini-key",
      upstreamTimeoutMs: 20,
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

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "model_timeout" },
    });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "MODEL_UPSTREAM_TIMEOUT",
        event: "model_gateway.request_failed",
        runId: "run-1",
        stage: "upstream_fetch",
      }),
    );
  });

  it("keeps the deadline active while buffering an upstream response", async () => {
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
      diagnostics: { report },
      fetchImplementation: async (_input, init) => {
        const signal = init?.signal;
        if (!signal) {
          throw new Error("Expected the gateway to provide an abort signal.");
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener("abort", () => controller.error(new Error("aborted")), {
                once: true,
              });
            },
          }),
        );
      },
      geminiApiKey: "test-gemini-key",
      upstreamTimeoutMs: 20,
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

    expect(response.status).toBe(504);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "MODEL_UPSTREAM_TIMEOUT",
        runId: "run-1",
        stage: "upstream_response",
      }),
    );
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
