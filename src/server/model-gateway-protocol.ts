import { createParser } from "eventsource-parser";

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

export function readOpenAiUsage(body: string, streaming: boolean): ModelGatewayUsage | null {
  if (!streaming) {
    try {
      return toModelGatewayUsage(JSON.parse(body));
    } catch (_error) {
      return null;
    }
  }

  let usage: ModelGatewayUsage | null = null;
  let malformed = false;
  const parser = createParser({
    onEvent({ data }) {
      if (!data.trim() || data.trim() === "[DONE]") {
        return;
      }
      try {
        usage = toModelGatewayUsage(JSON.parse(data)) ?? usage;
      } catch (_error) {
        malformed = true;
      }
    },
  });
  parser.feed(body);
  return malformed ? null : usage;
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
