import {
  type DiagnosticEvent,
  type DiagnosticReporter,
  noopDiagnosticReporter,
} from "../observability/contract";
import { readBoundedText } from "./model-gateway-body";
import {
  type ModelGatewayUsage,
  normalizeStreamingToolProtocol,
  parseOpenAiCompletionRequest,
  readOpenAiUsage,
  toUpstreamRequest,
} from "./model-gateway-protocol";

export type { ModelGatewayUsage } from "./model-gateway-protocol";

export type ModelGatewayCapability = {
  maxOutputTokens: number;
  modelId: string;
  projectId: string;
  runId: string;
};

export type ModelGatewayOptions = {
  authorize(request: Request): Promise<ModelGatewayCapability | null>;
  diagnostics?: DiagnosticReporter;
  endpointPath?: string;
  fetchImplementation?: typeof fetch;
  geminiApiKey: string;
  modelApiBaseUrl?: string;
  onUsage?(usage: ModelGatewayUsage, capability: ModelGatewayCapability): Promise<void> | void;
  upstreamTimeoutMs?: number;
};

const defaultEndpointPath = "/v1/chat/completions";
const defaultModelApiBaseUrl = "https://generativelanguage.googleapis.com";
export const defaultModelUpstreamTimeoutMs = 120_000;
const maxUpstreamErrorResponseBytes = 64 * 1_024;
const maxUpstreamResponseBytes = 8 * 1_024 * 1_024;

/**
 * Proxies the narrow OpenAI Chat Completions surface used by an AgentRuntime to
 * Gemini. The gateway replaces the sandbox capability with the platform key,
 * binds each request to one Run/model, caps output, and records usage before
 * returning the buffered upstream response.
 */
export function createOpenAiCompatibleModelGateway(options: ModelGatewayOptions) {
  if (!options.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is required for the ModelGateway");
  }

  const endpointPath = options.endpointPath ?? defaultEndpointPath;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const modelApiBaseUrl = (options.modelApiBaseUrl ?? defaultModelApiBaseUrl).replace(/\/$/, "");
  const diagnostics = options.diagnostics ?? noopDiagnosticReporter;
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? defaultModelUpstreamTimeoutMs;
  if (!Number.isSafeInteger(upstreamTimeoutMs) || upstreamTimeoutMs < 1) {
    throw new Error("ModelGateway upstreamTimeoutMs must be a positive integer");
  }

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
    const timeoutSignal = AbortSignal.timeout(upstreamTimeoutMs);
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
          signal: AbortSignal.any([request.signal, timeoutSignal]),
        },
      );
    } catch {
      if (timeoutSignal.aborted) {
        diagnostics.report({
          errorCode: "MODEL_UPSTREAM_TIMEOUT",
          event: "model_gateway.request_failed",
          modelId: capability.modelId,
          outcome: "failed",
          runId: capability.runId,
          stage: "upstream_fetch",
        });
        return gatewayError(504, "model_timeout", "The upstream model request timed out.");
      }

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
        if (timeoutSignal.aborted) {
          diagnostics.report({
            errorCode: "MODEL_UPSTREAM_TIMEOUT",
            event: "model_gateway.request_failed",
            modelId: capability.modelId,
            outcome: "failed",
            runId: capability.runId,
            stage: "upstream_response",
          });
          return gatewayError(504, "model_timeout", "The upstream model request timed out.");
        }
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
      if (timeoutSignal.aborted) {
        diagnostics.report({
          errorCode: "MODEL_UPSTREAM_TIMEOUT",
          event: "model_gateway.request_failed",
          modelId: capability.modelId,
          outcome: "failed",
          runId: capability.runId,
          stage: "upstream_response",
        });
        return gatewayError(504, "model_timeout", "The upstream model request timed out.");
      }
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

function gatewayError(status: number, code: string, message: string) {
  return Response.json(
    { error: { code, message, type: code } },
    {
      headers: { "cache-control": "no-store" },
      status,
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
