import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
  generateText,
  jsonSchema,
  type LanguageModelUsage,
  type ModelMessage,
  type ProviderMetadata,
  streamText,
  type ToolCallPart,
  type ToolChoice,
  type ToolSet,
  tool,
} from "ai";
import { readBoundedText } from "./model-gateway-body";
import type { OpenAiCompletionRequest } from "./model-gateway-protocol";

// Warnings may contain user-controlled tool names and request details.
globalThis.AI_SDK_LOG_WARNINGS = false;

export type SdkCompletionInput = {
  instructions: string;
  messages: ModelMessage[];
  tools: ToolSet;
  toolChoice: ToolChoice<ToolSet>;
  maxOutputTokens: number;
};

/** The text/function surface exposed by the current Pi runtime. */
export function toSdkCompletionInput(
  request: OpenAiCompletionRequest,
  maxOutputTokens: number,
): SdkCompletionInput | null {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 65536)
    return null;
  try {
    const tools: ToolSet = Object.create(null);
    for (const entry of request.tools ?? []) {
      if (entry.type !== "function" || !record(entry.function)) return null;
      const fn = entry.function;
      if (
        typeof fn.name !== "string" ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(fn.name) ||
        tools[fn.name] ||
        (fn.description !== undefined && typeof fn.description !== "string") ||
        !record(fn.parameters)
      )
        return null;
      tools[fn.name] = tool({
        ...(typeof fn.description === "string" ? { description: fn.description } : {}),
        inputSchema: jsonSchema(fn.parameters),
      });
    }
    let toolChoice: ToolChoice<ToolSet> = "auto";
    if (request.toolChoice !== undefined) {
      if (
        request.toolChoice === "auto" ||
        request.toolChoice === "none" ||
        request.toolChoice === "required"
      )
        toolChoice = request.toolChoice;
      else if (
        record(request.toolChoice) &&
        request.toolChoice.type === "function" &&
        record(request.toolChoice.function) &&
        typeof request.toolChoice.function.name === "string" &&
        tools[request.toolChoice.function.name]
      )
        toolChoice = { type: "tool", toolName: request.toolChoice.function.name };
      else return null;
    }
    if (toolChoice === "required" && !Object.keys(tools).length) return null;
    // Native Gemini has no equivalent that enforces sequential function calls.
    if (request.parallelToolCalls === false && Object.keys(tools).length) return null;
    const messages: ModelMessage[] = [];
    const instructions: string[] = [];
    const names = new Map<string, string>();
    for (const message of request.messages) {
      const content = textContent(message.content);
      if (content === null) return null;
      switch (message.role) {
        case "system":
        case "developer":
          instructions.push(content);
          break;
        case "user":
          messages.push({ role: "user", content });
          break;
        case "assistant": {
          const parts: Array<{ type: "text"; text: string } | ToolCallPart> = content
            ? [{ type: "text", text: content }]
            : [];
          for (const call of (message.tool_calls ?? []) as unknown[]) {
            if (
              !record(call) ||
              call.type !== "function" ||
              typeof call.id !== "string" ||
              !call.id ||
              !record(call.function) ||
              typeof call.function.name !== "string" ||
              typeof call.function.arguments !== "string" ||
              names.has(call.id)
            )
              return null;
            const input: unknown = JSON.parse(call.function.arguments);
            if (!record(input)) return null;
            names.set(call.id, call.function.name);
            const details = Array.isArray(message.reasoning_details)
              ? message.reasoning_details
              : [];
            const detail = details.find(
              (d) => record(d) && d.type === "reasoning.encrypted" && d.id === call.id,
            );
            const extra =
              record(call.extra_content) && record(call.extra_content.google)
                ? call.extra_content.google.thought_signature
                : undefined;
            const signature =
              record(detail) && typeof detail.data === "string" ? detail.data : extra;
            parts.push({
              type: "tool-call",
              toolCallId: call.id,
              toolName: call.function.name,
              input,
              ...(typeof signature === "string" && signature
                ? { providerOptions: { google: { thoughtSignature: signature } } }
                : {}),
            });
          }
          messages.push({ role: "assistant", content: parts });
          break;
        }
        case "tool": {
          if (typeof message.tool_call_id !== "string") return null;
          const name = names.get(message.tool_call_id);
          if (!name) return null;
          messages.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: message.tool_call_id,
                toolName: name,
                output: { type: "text", value: content },
              },
            ],
          });
          break;
        }
        default:
          return null;
      }
    }
    if (!messages.length) return null;
    return {
      instructions: instructions.join("\n\n"),
      messages,
      tools,
      toolChoice,
      maxOutputTokens,
    };
  } catch {
    return null;
  }
}

function textContent(content: unknown): string | null {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  // Never let SDK media conversion fetch sandbox-supplied URLs.
  if (
    content.some((part) => !record(part) || part.type !== "text" || typeof part.text !== "string")
  )
    return null;
  return content.map((part) => part.text).join("");
}

export class SdkUpstreamError extends Error {
  constructor(readonly stage: "upstream_fetch" | "upstream_response") {
    super("Model provider request failed");
  }
}

export async function createSdkCompletionResponse(
  input: SdkCompletionInput,
  options: {
    modelId: string;
    stream: boolean;
    apiKey: string;
    baseURL: string;
    fetchImplementation: typeof fetch;
    signal: AbortSignal;
  },
): Promise<Response> {
  let receivedHeaders = false;
  let rejected: Response | undefined;
  const provider = createGoogleGenerativeAI({
    apiKey: options.apiKey,
    baseURL: `${options.baseURL}/v1beta`,
    fetch: async (url, init) => {
      const response = await options.fetchImplementation(url, { ...init, redirect: "manual" });
      receivedHeaders = true;
      const body = await readBoundedText(response.body, response.ok ? 8 * 1024 * 1024 : 64 * 1024);
      if (!response.ok) {
        rejected = new Response(body.kind === "ok" ? body.value : "", { status: response.status });
        throw new SdkUpstreamError("upstream_response");
      }
      if (body.kind !== "ok") throw new SdkUpstreamError("upstream_response");
      return new Response(body.value, { status: response.status, headers: response.headers });
    },
  });
  const settings = {
    ...input,
    model: provider(options.modelId),
    maxRetries: 0,
    abortSignal: options.signal,
    telemetry: { isEnabled: false },
    experimental_download: async (items: Array<unknown>) => {
      if (items.length) throw new Error("Media download is disabled");
      return [];
    },
  };
  try {
    let text = "";
    const calls: Array<Record<string, unknown>> = [];
    const signatures: Array<Record<string, unknown>> = [];
    const addCall = (call: {
      toolCallId: string;
      toolName: string;
      input: unknown;
      providerMetadata?: ProviderMetadata;
    }) => {
      if (!call.toolCallId || !Object.hasOwn(input.tools, call.toolName) || !record(call.input))
        throw new SdkUpstreamError("upstream_response");
      const signature = call.providerMetadata?.google?.thoughtSignature;
      calls.push({
        id: call.toolCallId,
        type: "function",
        function: { name: call.toolName, arguments: JSON.stringify(call.input) },
        ...(typeof signature === "string"
          ? { extra_content: { google: { thought_signature: signature } } }
          : {}),
      });
      if (typeof signature === "string")
        signatures.push({ type: "reasoning.encrypted", id: call.toolCallId, data: signature });
    };
    let usage: LanguageModelUsage | undefined;
    let metadata: ProviderMetadata | undefined;
    let finishReason: string | undefined;
    if (options.stream) {
      const result = streamText({ ...settings, streamRetries: 0, onError: () => {} });
      for await (const event of result.fullStream) {
        if (event.type === "error" || event.type === "abort")
          throw new SdkUpstreamError("upstream_response");
        if (event.type === "text-delta") text += event.text;
        if (event.type === "tool-call") addCall(event);
        if (event.type === "finish-step") metadata = event.providerMetadata;
        if (event.type === "finish") {
          usage = event.totalUsage;
          finishReason = event.finishReason;
        }
      }
    } else {
      const result = await generateText(settings);
      text = result.text;
      for (const call of result.toolCalls) addCall(call);
      usage = result.usage;
      metadata = result.providerMetadata;
      finishReason = result.finishReason;
    }
    // Require actual provider counters; SDK defaults are not measured usage.
    const raw = metadata?.google?.usageMetadata;
    if (
      !usage ||
      !record(raw) ||
      !count(raw.promptTokenCount) ||
      !count(raw.candidatesTokenCount) ||
      !count(raw.totalTokenCount) ||
      !count(usage.inputTokens) ||
      !count(usage.outputTokens) ||
      raw.totalTokenCount < usage.inputTokens + usage.outputTokens
    )
      throw new SdkUpstreamError("upstream_response");
    const finish = (
      {
        stop: "stop",
        length: "length",
        "tool-calls": "tool_calls",
        "content-filter": "content_filter",
      } as Record<string, string>
    )[finishReason ?? ""];
    if (!finish) throw new SdkUpstreamError("upstream_response");
    const message = {
      role: "assistant",
      content: text || null,
      ...(calls.length ? { tool_calls: calls } : {}),
      ...(signatures.length ? { reasoning_details: signatures } : {}),
    };
    const publicUsage = {
      prompt_tokens: usage.inputTokens,
      completion_tokens: raw.candidatesTokenCount,
      total_tokens: raw.totalTokenCount,
    };
    const base = {
      id: `chatcmpl-${crypto.randomUUID()}`,
      created: Math.floor(Date.now() / 1000),
      model: options.modelId,
    };
    const body = options.stream
      ? [
          `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { ...message, ...(calls.length ? { tool_calls: calls.map((call, index) => ({ ...call, index })) } : {}) }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`,
          `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [], usage: publicUsage })}\n\n`,
          "data: [DONE]\n\n",
        ].join("")
      : JSON.stringify({
          ...base,
          object: "chat.completion",
          choices: [{ index: 0, message, finish_reason: finish }],
          usage: publicUsage,
        });
    if (new TextEncoder().encode(body).byteLength > 8 * 1024 * 1024)
      throw new SdkUpstreamError("upstream_response");
    return new Response(body, {
      headers: {
        "content-type": options.stream
          ? "text/event-stream; charset=utf-8"
          : "application/json; charset=utf-8",
      },
    });
  } catch {
    if (rejected) return rejected;
    throw new SdkUpstreamError(receivedHeaders ? "upstream_response" : "upstream_fetch");
  }
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
