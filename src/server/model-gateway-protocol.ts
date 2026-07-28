import { readBoundedText } from "./model-gateway-body";

export type ModelGatewayUsage = {
  inputTokens: number;
  modelRequestCount: number;
  outputTokens: number;
  totalTokens: number;
};

export type OpenAiCompletionRequest = {
  messages: Array<Record<string, unknown>>;
  model: string;
  parallelToolCalls?: boolean;
  stream: boolean;
  toolChoice?: unknown;
  tools?: Array<Record<string, unknown>>;
};

const maxCompletionRequestBytes = 4 * 1_024 * 1_024;

export async function parseOpenAiCompletionRequest(
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

export function toUpstreamRequest(request: OpenAiCompletionRequest, maxOutputTokens: number) {
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

export function normalizeStreamingToolProtocol(body: string) {
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

export function readOpenAiUsage(body: string, streaming: boolean): ModelGatewayUsage | null {
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

function readContentLength(headers: Headers) {
  const rawValue = headers.get("content-length");
  if (rawValue === null) {
    return null;
  }

  const value = Number(rawValue);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
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
