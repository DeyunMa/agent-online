import {
  type DiagnosticEvent,
  type DiagnosticReporter,
  noopDiagnosticReporter,
} from "../observability/contract";

export type ModelGatewayCapability = {
  maxOutputTokens: number;
  modelId: string;
  projectId: string;
  runId: string;
};

export type ModelGatewayUsage = {
  inputTokens: number;
  modelRequestCount: number;
  outputTokens: number;
  totalTokens: number;
};

export type ModelGatewayOptions = {
  authorize(request: Request): Promise<ModelGatewayCapability | null>;
  diagnostics?: DiagnosticReporter;
  endpointPath?: string;
  fetchImplementation?: typeof fetch;
  geminiApiKey: string;
  modelApiBaseUrl?: string;
  onUsage?(usage: ModelGatewayUsage, capability: ModelGatewayCapability): Promise<void> | void;
};

type OpenAiCompletionRequest = {
  messages: Array<Record<string, unknown>>;
  model: string;
  parallelToolCalls?: boolean;
  stream: boolean;
  toolChoice?: unknown;
  tools?: Array<Record<string, unknown>>;
};

const defaultEndpointPath = "/v1/chat/completions";
const defaultModelApiBaseUrl = "https://generativelanguage.googleapis.com";
const maxCompletionRequestBytes = 4 * 1_024 * 1_024;
const maxUpstreamErrorResponseBytes = 64 * 1_024;
const maxUpstreamResponseBytes = 8 * 1_024 * 1_024;

/**
 * Proxies the narrow OpenAI Chat Completions surface used by Pi to Gemini's
 * compatibility endpoint. The gateway replaces the sandbox capability with
 * the platform key, binds each request to one Run/model, caps output, and
 * records usage before returning the buffered upstream response.
 */
export function createOpenAiCompatibleModelGateway(options: ModelGatewayOptions) {
  if (!options.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is required for the ModelGateway");
  }

  const endpointPath = options.endpointPath ?? defaultEndpointPath;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const modelApiBaseUrl = (options.modelApiBaseUrl ?? defaultModelApiBaseUrl).replace(/\/$/, "");
  const diagnostics = options.diagnostics ?? noopDiagnosticReporter;

  return async function handleOpenAiChatCompletion(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== endpointPath) {
      return gatewayError(404, "not_found", "The requested ModelGateway endpoint does not exist.");
    }

    let capability: ModelGatewayCapability | null;
    try {
      capability = await options.authorize(request);
    } catch {
      diagnostics.report({
        errorCode: "MODEL_CAPABILITY_INVALID",
        event: "model_gateway.request_failed",
        outcome: "failed",
        stage: "authorize",
      });
      return gatewayError(
        500,
        "authorization_error",
        "ModelGateway authorization could not be evaluated.",
      );
    }

    if (!capability) {
      diagnostics.report({
        errorCode: "MODEL_CAPABILITY_INVALID",
        event: "model_gateway.request_failed",
        outcome: "rejected",
        stage: "authorize",
      });
      return gatewayError(
        401,
        "invalid_api_key",
        "The ModelGateway capability is invalid or expired.",
      );
    }

    const parsedRequest = await parseOpenAiCompletionRequest(request);
    if (parsedRequest.kind === "too_large") {
      return gatewayError(
        413,
        "invalid_request_error",
        "The completion request exceeds the ModelGateway byte limit.",
      );
    }
    if (parsedRequest.kind === "invalid") {
      return gatewayError(
        400,
        "invalid_request_error",
        "The completion request is not supported by this ModelGateway.",
      );
    }
    const parsed = parsedRequest.value;

    if (parsed.model !== capability.modelId) {
      return gatewayError(
        403,
        "model_not_allowed",
        "The requested model is not allowed by this capability.",
      );
    }

    const upstreamRequest = toUpstreamRequest(parsed, capability.maxOutputTokens);
    if (!upstreamRequest) {
      return gatewayError(
        400,
        "invalid_request_error",
        "The completion request exceeds the Run limits.",
      );
    }

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetchImplementation(
        `${modelApiBaseUrl}/v1beta/openai/chat/completions`,
        {
          body: JSON.stringify(upstreamRequest),
          headers: {
            accept: parsed.stream ? "text/event-stream" : "application/json",
            authorization: `Bearer ${options.geminiApiKey}`,
            "content-type": "application/json",
          },
          method: "POST",
        },
      );
    } catch {
      diagnostics.report({
        errorCode: "MODEL_UPSTREAM_REJECTED",
        event: "model_gateway.request_failed",
        modelId: capability.modelId,
        outcome: "failed",
        runId: capability.runId,
        stage: "upstream_fetch",
      });
      return gatewayError(502, "model_unavailable", "The upstream model request failed.");
    }

    if (!upstreamResponse.ok) {
      const upstreamDiagnostic = await readUpstreamErrorDiagnostic(upstreamResponse);
      diagnostics.report({
        errorCode: "MODEL_UPSTREAM_REJECTED",
        event: "model_gateway.request_failed",
        modelId: capability.modelId,
        outcome: "failed",
        runId: capability.runId,
        stage: "upstream_response",
        upstreamCategory: upstreamDiagnostic.errorCategory,
        upstreamHttpStatus: upstreamDiagnostic.upstreamHttpStatus,
      });
      return gatewayError(502, "model_unavailable", "The upstream model request was rejected.");
    }

    let upstreamBody: string;
    try {
      const body = await readBoundedText(upstreamResponse.body, maxUpstreamResponseBytes);
      if (body.kind !== "ok") {
        diagnostics.report({
          errorCode: "MODEL_UPSTREAM_REJECTED",
          event: "model_gateway.request_failed",
          modelId: capability.modelId,
          outcome: "failed",
          runId: capability.runId,
          stage: "upstream_response",
        });
        return gatewayError(
          502,
          "invalid_model_response",
          body.kind === "too_large"
            ? "The upstream model response exceeded the gateway limit."
            : "The upstream model response was invalid.",
        );
      }
      upstreamBody = body.value;
    } catch {
      diagnostics.report({
        errorCode: "MODEL_UPSTREAM_REJECTED",
        event: "model_gateway.request_failed",
        modelId: capability.modelId,
        outcome: "failed",
        runId: capability.runId,
        stage: "upstream_response",
      });
      return gatewayError(
        502,
        "invalid_model_response",
        "The upstream model response was invalid.",
      );
    }

    const responseBody = parsed.stream
      ? normalizeStreamingToolProtocol(upstreamBody)
      : upstreamBody;
    const usage = readOpenAiUsage(responseBody, parsed.stream);
    if (!usage) {
      diagnostics.report({
        errorCode: "MODEL_UPSTREAM_REJECTED",
        event: "model_gateway.request_failed",
        modelId: capability.modelId,
        outcome: "failed",
        runId: capability.runId,
        stage: "upstream_response",
      });
      return gatewayError(
        502,
        "invalid_model_response",
        "The upstream model response did not contain usage.",
      );
    }

    try {
      await options.onUsage?.(usage, capability);
    } catch {
      diagnostics.report({
        errorCode: "MODEL_USAGE_WRITE_FAILED",
        event: "model_gateway.request_failed",
        modelId: capability.modelId,
        outcome: "failed",
        runId: capability.runId,
        stage: "usage_write",
      });
      return gatewayError(
        500,
        "usage_recording_failed",
        "The ModelGateway could not record usage.",
      );
    }

    return new Response(responseBody, {
      headers: {
        "cache-control": "no-store",
        "content-type":
          upstreamResponse.headers.get("content-type") ??
          (parsed.stream ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8"),
      },
      status: upstreamResponse.status,
    });
  };
}

async function readUpstreamErrorDiagnostic(response: Response) {
  const diagnostic: {
    errorCategory: NonNullable<DiagnosticEvent["upstreamCategory"]>;
    upstreamErrorCode?: number | string;
    upstreamErrorStatus?: string;
    upstreamHttpStatus: number;
  } = {
    errorCategory: "other",
    upstreamHttpStatus: response.status,
  };

  try {
    const body = await readBoundedText(response.body, maxUpstreamErrorResponseBytes);
    if (body.kind !== "ok") {
      return diagnostic;
    }
    const payload: unknown = JSON.parse(body.value);
    if (!isRecord(payload) || !isRecord(payload.error)) {
      return diagnostic;
    }

    if (typeof payload.error.code === "number" || typeof payload.error.code === "string") {
      diagnostic.upstreamErrorCode = payload.error.code;
    }
    if (typeof payload.error.status === "string") {
      diagnostic.upstreamErrorStatus = payload.error.status;
    }
    if (typeof payload.error.message === "string") {
      diagnostic.errorCategory = categorizeUpstreamError(payload.error.message);
    }
  } catch (_error) {
    // The public response stays generic even when the upstream error is not JSON.
  }

  return diagnostic;
}

function categorizeUpstreamError(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes("thought_signature")) {
    return "thought_signature";
  }
  if (
    normalized.includes("resource_exhausted") ||
    normalized.includes("rate limit") ||
    normalized.includes("quota")
  ) {
    return "rate_limited";
  }
  if (normalized.includes("context window") || normalized.includes("token limit")) {
    return "context_limit";
  }
  if (normalized.includes("model") && normalized.includes("not found")) {
    return "model_not_found";
  }

  return "other";
}

function normalizeStreamingToolProtocol(body: string) {
  const choicesWithToolCalls = new Set<number>();

  return body
    .split(/\r?\n/)
    .map((line) => {
      if (!line.startsWith("data:")) {
        return line;
      }

      const data = line.slice("data:".length).trim();
      if (!data || data === "[DONE]") {
        return line;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch (_error) {
        return line;
      }
      if (!isRecord(payload) || !Array.isArray(payload.choices)) {
        return line;
      }

      let changed = false;
      for (const rawChoice of payload.choices) {
        if (!isRecord(rawChoice)) {
          continue;
        }

        const index =
          typeof rawChoice.index === "number" && Number.isSafeInteger(rawChoice.index)
            ? rawChoice.index
            : 0;
        if (
          isRecord(rawChoice.delta) &&
          Array.isArray(rawChoice.delta.tool_calls) &&
          rawChoice.delta.tool_calls.length > 0
        ) {
          choicesWithToolCalls.add(index);
          const reasoningDetails = Array.isArray(rawChoice.delta.reasoning_details)
            ? [...rawChoice.delta.reasoning_details]
            : [];
          for (const rawToolCall of rawChoice.delta.tool_calls) {
            if (!isRecord(rawToolCall) || typeof rawToolCall.id !== "string") {
              continue;
            }

            const signature = readGoogleThoughtSignature(rawToolCall);
            if (
              !signature ||
              reasoningDetails.some(
                (detail) =>
                  isRecord(detail) &&
                  detail.type === "reasoning.encrypted" &&
                  detail.id === rawToolCall.id,
              )
            ) {
              continue;
            }

            reasoningDetails.push({
              data: signature,
              id: rawToolCall.id,
              type: "reasoning.encrypted",
            });
            changed = true;
          }
          if (reasoningDetails.length > 0) {
            rawChoice.delta.reasoning_details = reasoningDetails;
          }
        }

        if (choicesWithToolCalls.has(index) && rawChoice.finish_reason === "stop") {
          rawChoice.finish_reason = "tool_calls";
          changed = true;
        }
      }

      return changed ? `data: ${JSON.stringify(payload)}` : line;
    })
    .join("\n");
}

async function parseOpenAiCompletionRequest(
  request: Request,
): Promise<
  { kind: "invalid" } | { kind: "ok"; value: OpenAiCompletionRequest } | { kind: "too_large" }
> {
  const declaredLength = readContentLength(request.headers);
  if (declaredLength !== null && declaredLength > maxCompletionRequestBytes) {
    return { kind: "too_large" };
  }

  const body = await readBoundedText(request.body, maxCompletionRequestBytes);
  if (body.kind !== "ok") {
    return body;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body.value);
  } catch (_error) {
    return { kind: "invalid" };
  }

  if (
    !isRecord(payload) ||
    typeof payload.model !== "string" ||
    !Array.isArray(payload.messages) ||
    payload.messages.length === 0 ||
    payload.messages.length > 256
  ) {
    return { kind: "invalid" };
  }

  if (
    (payload.stream !== undefined && typeof payload.stream !== "boolean") ||
    (payload.n !== undefined && payload.n !== 1)
  ) {
    return { kind: "invalid" };
  }

  const messages: Array<Record<string, unknown>> = [];
  for (const rawMessage of payload.messages) {
    if (
      !isRecord(rawMessage) ||
      !isOpenAiRole(rawMessage.role) ||
      !isOpenAiContent(rawMessage.content)
    ) {
      return { kind: "invalid" };
    }

    if (rawMessage.tool_calls !== undefined && !Array.isArray(rawMessage.tool_calls)) {
      return { kind: "invalid" };
    }

    if (rawMessage.role === "tool" && typeof rawMessage.tool_call_id !== "string") {
      return { kind: "invalid" };
    }

    messages.push(rawMessage);
  }

  let tools: Array<Record<string, unknown>> | undefined;
  if (payload.tools !== undefined) {
    if (
      !Array.isArray(payload.tools) ||
      payload.tools.length > 128 ||
      payload.tools.some((tool) => !isRecord(tool))
    ) {
      return { kind: "invalid" };
    }
    tools = payload.tools;
  }

  if (
    payload.tool_choice !== undefined &&
    typeof payload.tool_choice !== "string" &&
    !isRecord(payload.tool_choice)
  ) {
    return { kind: "invalid" };
  }

  if (
    payload.parallel_tool_calls !== undefined &&
    typeof payload.parallel_tool_calls !== "boolean"
  ) {
    return { kind: "invalid" };
  }

  return {
    kind: "ok",
    value: {
      messages,
      model: payload.model,
      ...(typeof payload.parallel_tool_calls === "boolean"
        ? { parallelToolCalls: payload.parallel_tool_calls }
        : {}),
      stream: payload.stream === true,
      ...(payload.tool_choice !== undefined ? { toolChoice: payload.tool_choice } : {}),
      ...(tools ? { tools } : {}),
    },
  };
}

type BoundedTextResult =
  | { kind: "invalid" }
  | { kind: "ok"; value: string }
  | { kind: "too_large" };

async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<BoundedTextResult> {
  if (!body) {
    return { kind: "ok", value: "" };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: "too_large" };
      }
      chunks.push(chunk.value);
    }
  } catch (_error) {
    return { kind: "invalid" };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return {
      kind: "ok",
      value: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch (_error) {
    return { kind: "invalid" };
  }
}

function readContentLength(headers: Headers) {
  const rawValue = headers.get("content-length");
  if (rawValue === null) {
    return null;
  }

  const value = Number(rawValue);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function toUpstreamRequest(request: OpenAiCompletionRequest, maxOutputTokens: number) {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 65_536) {
    return null;
  }

  return {
    max_tokens: maxOutputTokens,
    messages: toGeminiOpenAiMessages(request.messages),
    model: request.model,
    ...(request.parallelToolCalls !== undefined
      ? { parallel_tool_calls: request.parallelToolCalls }
      : {}),
    stream: request.stream,
    ...(request.stream ? { stream_options: { include_usage: true } } : {}),
    ...(request.toolChoice !== undefined ? { tool_choice: request.toolChoice } : {}),
    ...(request.tools ? { tools: request.tools } : {}),
  };
}

function toGeminiOpenAiMessages(messages: Array<Record<string, unknown>>) {
  return messages.map((message) => {
    if (message.role !== "assistant") {
      return message;
    }

    const { reasoning_details: rawReasoningDetails, ...forwardedMessage } = message;
    if (!Array.isArray(message.tool_calls)) {
      return forwardedMessage;
    }

    const signatures = new Map<string, string>();
    if (Array.isArray(rawReasoningDetails)) {
      for (const detail of rawReasoningDetails) {
        if (
          isRecord(detail) &&
          detail.type === "reasoning.encrypted" &&
          typeof detail.id === "string" &&
          typeof detail.data === "string" &&
          detail.data
        ) {
          signatures.set(detail.id, detail.data);
        }
      }
    }

    return {
      ...forwardedMessage,
      tool_calls: message.tool_calls.map((rawToolCall) => {
        if (!isRecord(rawToolCall) || typeof rawToolCall.id !== "string") {
          return rawToolCall;
        }

        const signature = signatures.get(rawToolCall.id);
        if (!signature) {
          return rawToolCall;
        }

        const extraContent = isRecord(rawToolCall.extra_content) ? rawToolCall.extra_content : {};
        const google = isRecord(extraContent.google) ? extraContent.google : {};
        return {
          ...rawToolCall,
          extra_content: {
            ...extraContent,
            google: {
              ...google,
              thought_signature: signature,
            },
          },
        };
      }),
    };
  });
}

function readGoogleThoughtSignature(toolCall: Record<string, unknown>) {
  if (!isRecord(toolCall.extra_content) || !isRecord(toolCall.extra_content.google)) {
    return null;
  }

  const signature = toolCall.extra_content.google.thought_signature;
  return typeof signature === "string" && signature ? signature : null;
}

function readOpenAiUsage(body: string, streaming: boolean): ModelGatewayUsage | null {
  if (!streaming) {
    try {
      return toModelGatewayUsage(JSON.parse(body));
    } catch (_error) {
      return null;
    }
  }

  let usage: ModelGatewayUsage | null = null;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }

    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") {
      continue;
    }

    try {
      usage = toModelGatewayUsage(JSON.parse(data)) ?? usage;
    } catch (_error) {
      return null;
    }
  }

  return usage;
}

function toModelGatewayUsage(payload: unknown): ModelGatewayUsage | null {
  if (!isRecord(payload) || !isRecord(payload.usage)) {
    return null;
  }

  const inputTokens = readNonNegativeInteger(payload.usage.prompt_tokens);
  const outputTokens = readNonNegativeInteger(payload.usage.completion_tokens);
  const totalTokens = readNonNegativeInteger(payload.usage.total_tokens);
  if (
    inputTokens === null ||
    outputTokens === null ||
    totalTokens === null ||
    totalTokens < inputTokens + outputTokens
  ) {
    return null;
  }

  return {
    inputTokens,
    modelRequestCount: 1,
    outputTokens,
    totalTokens,
  };
}

function gatewayError(status: number, code: string, message: string) {
  return Response.json(
    { error: { code, message, type: code } },
    {
      headers: { "cache-control": "no-store" },
      status,
    },
  );
}

function isOpenAiContent(value: unknown) {
  return value === undefined || value === null || typeof value === "string" || Array.isArray(value);
}

function isOpenAiRole(value: unknown) {
  return (
    value === "assistant" ||
    value === "developer" ||
    value === "system" ||
    value === "tool" ||
    value === "user"
  );
}

function readNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
