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
  fetchImplementation?: typeof fetch;
  geminiApiKey: string;
  modelApiBaseUrl?: string;
  endpointPath?: string;
  onUsage?(usage: ModelGatewayUsage, capability: ModelGatewayCapability): Promise<void> | void;
};

type OpenAiMessage = {
  content: string;
  role: "assistant" | "developer" | "system" | "user";
};

type OpenAiCompletionRequest = {
  messages: OpenAiMessage[];
  model: string;
  stream: boolean;
};

const defaultModelApiBaseUrl = "https://generativelanguage.googleapis.com";
const defaultEndpointPath = "/v1/chat/completions";

/**
 * Translates the narrow OpenAI Chat Completions subset used by the Pi spike
 * into Gemini GenerateContent. Authentication and Run authorization stay
 * outside this adapter so D2 can replace the spike bearer token with a signed
 * Run-scoped capability without changing the protocol translation.
 */
export function createOpenAiCompatibleModelGateway(options: ModelGatewayOptions) {
  if (!options.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is required for the ModelGateway");
  }

  const fetchImplementation = options.fetchImplementation ?? fetch;
  const modelApiBaseUrl = (options.modelApiBaseUrl ?? defaultModelApiBaseUrl).replace(/\/$/, "");
  const endpointPath = options.endpointPath ?? defaultEndpointPath;

  return async function handleOpenAiChatCompletion(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== endpointPath) {
      return gatewayError(404, "not_found", "The requested ModelGateway endpoint does not exist.");
    }

    let capability: ModelGatewayCapability | null;
    try {
      capability = await options.authorize(request);
    } catch (_error) {
      return gatewayError(500, "authorization_error", "ModelGateway authorization could not be evaluated.");
    }

    if (!capability) {
      return gatewayError(401, "invalid_api_key", "The ModelGateway capability is invalid or expired.");
    }

    const parsed = await parseOpenAiCompletionRequest(request);
    if (!parsed) {
      return gatewayError(400, "invalid_request_error", "The completion request is not supported by this ModelGateway.");
    }

    if (parsed.model !== capability.modelId) {
      return gatewayError(403, "model_not_allowed", "The requested model is not allowed by this capability.");
    }

    const geminiRequest = toGeminiRequest(parsed.messages, capability.maxOutputTokens);
    if (!geminiRequest) {
      return gatewayError(400, "invalid_request_error", "The completion messages are not supported by this ModelGateway.");
    }

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetchImplementation(
        `${modelApiBaseUrl}/v1beta/models/${encodeURIComponent(capability.modelId)}:generateContent`,
        {
          body: JSON.stringify(geminiRequest),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-goog-api-key": options.geminiApiKey,
          },
          method: "POST",
        },
      );
    } catch (_error) {
      return gatewayError(502, "model_unavailable", "The upstream model request failed.");
    }

    if (!upstreamResponse.ok) {
      return gatewayError(502, "model_unavailable", "The upstream model request was rejected.");
    }

    let upstreamPayload: unknown;
    try {
      upstreamPayload = await upstreamResponse.json();
    } catch (_error) {
      return gatewayError(502, "invalid_model_response", "The upstream model response was invalid.");
    }

    const assistantText = getGeminiAssistantText(upstreamPayload);
    if (assistantText === null) {
      return gatewayError(502, "invalid_model_response", "The upstream model response did not contain assistant text.");
    }

    const usage = getGeminiUsage(upstreamPayload);
    try {
      await options.onUsage?.(usage, capability);
    } catch (_error) {
      return gatewayError(500, "usage_recording_failed", "The ModelGateway could not record usage.");
    }

    return parsed.stream
      ? streamingCompletionResponse(capability.modelId, assistantText, usage)
      : completionResponse(capability.modelId, assistantText, usage);
  };
}

async function parseOpenAiCompletionRequest(request: Request): Promise<OpenAiCompletionRequest | null> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch (_error) {
    return null;
  }

  if (!isRecord(payload) || typeof payload.model !== "string" || !Array.isArray(payload.messages)) {
    return null;
  }

  if (payload.tools !== undefined && (!Array.isArray(payload.tools) || payload.tools.length > 0)) {
    return null;
  }

  const messages: OpenAiMessage[] = [];
  for (const rawMessage of payload.messages) {
    if (!isRecord(rawMessage) || !isOpenAiRole(rawMessage.role)) {
      return null;
    }

    const content = getOpenAiTextContent(rawMessage.content);
    if (content === null) {
      return null;
    }

    messages.push({ content, role: rawMessage.role });
  }

  return messages.length > 0
    ? { messages, model: payload.model, stream: payload.stream === true }
    : null;
}

function toGeminiRequest(messages: OpenAiMessage[], maxOutputTokens: number) {
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
    return null;
  }

  const contents: Array<{ parts: Array<{ text: string }>; role: "model" | "user" }> = [];
  const systemParts: Array<{ text: string }> = [];

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      systemParts.push({ text: message.content });
      continue;
    }

    contents.push({
      parts: [{ text: message.content }],
      role: message.role === "assistant" ? "model" : "user",
    });
  }

  if (contents.length === 0) {
    return null;
  }

  return {
    ...(systemParts.length > 0 ? { systemInstruction: { parts: systemParts } } : {}),
    contents,
    generationConfig: { maxOutputTokens },
  };
}

function getOpenAiTextContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const textParts: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
      return null;
    }

    textParts.push(part.text);
  }

  return textParts.join("");
}

function getGeminiAssistantText(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.candidates) || !isRecord(payload.candidates[0])) {
    return null;
  }

  const content = payload.candidates[0].content;
  if (!isRecord(content) || !Array.isArray(content.parts)) {
    return null;
  }

  const textParts = content.parts.flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []));
  return textParts.length > 0 ? textParts.join("") : null;
}

function getGeminiUsage(payload: unknown): ModelGatewayUsage {
  const usageMetadata = isRecord(payload) && isRecord(payload.usageMetadata) ? payload.usageMetadata : {};
  const inputTokens = getNonNegativeInteger(usageMetadata.promptTokenCount);
  const outputTokens = getNonNegativeInteger(usageMetadata.candidatesTokenCount);
  const totalTokens = getNonNegativeInteger(usageMetadata.totalTokenCount) || inputTokens + outputTokens;

  return {
    inputTokens,
    modelRequestCount: 1,
    outputTokens,
    totalTokens,
  };
}

function completionResponse(model: string, assistantText: string, usage: ModelGatewayUsage) {
  return Response.json(
    {
      choices: [
        {
          finish_reason: "stop",
          index: 0,
          message: { content: assistantText, role: "assistant" },
        },
      ],
      created: Math.floor(Date.now() / 1_000),
      id: `chatcmpl-${crypto.randomUUID()}`,
      model,
      object: "chat.completion",
      usage: toOpenAiUsage(usage),
    },
    {
      headers: { "cache-control": "no-store" },
    },
  );
}

function streamingCompletionResponse(model: string, assistantText: string, usage: ModelGatewayUsage) {
  const created = Math.floor(Date.now() / 1_000);
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const chunks = [
    {
      choices: [{ delta: { role: "assistant" }, finish_reason: null, index: 0 }],
      created,
      id,
      model,
      object: "chat.completion.chunk",
    },
    {
      choices: [{ delta: { content: assistantText }, finish_reason: null, index: 0 }],
      created,
      id,
      model,
      object: "chat.completion.chunk",
    },
    {
      choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
      created,
      id,
      model,
      object: "chat.completion.chunk",
    },
    {
      choices: [],
      created,
      id,
      model,
      object: "chat.completion.chunk",
      usage: toOpenAiUsage(usage),
    },
  ];

  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
    },
  });
}

function toOpenAiUsage(usage: ModelGatewayUsage) {
  return {
    completion_tokens: usage.outputTokens,
    prompt_tokens: usage.inputTokens,
    total_tokens: usage.totalTokens,
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

function getNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function isOpenAiRole(value: unknown): value is OpenAiMessage["role"] {
  return value === "assistant" || value === "developer" || value === "system" || value === "user";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
