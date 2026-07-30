import * as Sentry from "@sentry/cloudflare";
import type { CloudflareOptions, ErrorEvent, Stacktrace } from "@sentry/cloudflare";

import {
  type DiagnosticContext,
  type DiagnosticEvent,
  type DiagnosticReporter,
  diagnosticErrorDefinitions,
} from "../../observability/contract";
import type { AppBindings } from "../env";

const sentryTagKeys = new Set([
  "agent.runtime",
  "diagnostic.code",
  "diagnostic.event",
  "diagnostic.stage",
  "failure.code",
  "model.id",
  "run.status",
  "sandbox.runtime",
]);

const sentryContextKeys = new Set([
  "preview_session_id",
  "request_id",
  "run_id",
  "terminal_session_id",
  "attempt",
  "duration_ms",
  "input_tokens",
  "model_request_count",
  "output_tokens",
  "sandbox_duration_ms",
  "total_tokens",
  "upstream_http_status",
]);

export function createServerSentryOptions(
  env: Pick<AppBindings, "SENTRY_DSN" | "SENTRY_ENVIRONMENT"> = {},
): CloudflareOptions {
  return {
    beforeBreadcrumb: () => null,
    beforeSend: sanitizeSentryEvent,
    dataCollection: {
      cookies: false,
      databaseQueryData: false,
      genAI: {
        inputs: false,
        outputs: false,
      },
      graphQL: {
        document: false,
        variables: false,
      },
      httpBodies: [],
      httpHeaders: {
        request: false,
        response: false,
      },
      stackFrameVariables: false,
      urlQueryParams: false,
      userInfo: false,
    },
    dsn: env.SENTRY_DSN,
    enableLogs: false,
    enableMetrics: false,
    enabled: Boolean(env.SENTRY_DSN),
    environment: env.SENTRY_ENVIRONMENT ?? "development",
    maxBreadcrumbs: 0,
    sampleRate: 1,
  };
}

export function createSentryDiagnosticReporter(
  context: DiagnosticContext = {},
): DiagnosticReporter {
  return {
    report(event) {
      if (!shouldReportDiagnosticToSentry(event)) {
        return;
      }

      try {
        Sentry.withScope((scope) => {
          const diagnostic = toSentryDiagnostic(context, event);
          scope.setFingerprint(diagnostic.fingerprint);
          scope.setLevel("error");
          scope.setTags(diagnostic.tags);
          scope.setContext("agent_online", diagnostic.context);
          Sentry.captureMessage("Agent Online diagnostic failure");
        });
      } catch {
        // External observability must never change product execution.
      }
    },
  };
}

export function captureServerException(error: unknown, context: DiagnosticContext = {}) {
  try {
    Sentry.withScope((scope) => {
      scope.setContext("agent_online", toCorrelationContext(context));
      scope.setTag("diagnostic.event", "request.unhandled");
      Sentry.captureException(error);
    });
  } catch {
    // External observability must never change product execution.
  }
}

export function sanitizeSentryEvent(event: ErrorEvent): ErrorEvent {
  const exception = sanitizeException(event.exception);
  const tags = sanitizeTags(event.tags);
  const contexts = sanitizeContexts(event.contexts);
  const fingerprint = sanitizeFingerprint(event.fingerprint);

  return {
    ...(event.debug_meta ? { debug_meta: event.debug_meta } : {}),
    ...(event.environment ? { environment: event.environment } : {}),
    ...(event.event_id ? { event_id: event.event_id } : {}),
    ...(exception ? { exception } : {}),
    ...(fingerprint && fingerprint.length > 0 ? { fingerprint } : {}),
    ...(event.level ? { level: event.level } : {}),
    ...(event.platform ? { platform: event.platform } : {}),
    ...(event.release ? { release: event.release } : {}),
    ...(event.sdk ? { sdk: event.sdk } : {}),
    ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    ...(contexts ? { contexts } : {}),
    ...(tags ? { tags } : {}),
    logger: "agent-online",
    message: "Agent Online application error",
    type: event.type,
  };
}

function sanitizeFingerprint(fingerprint: ErrorEvent["fingerprint"]) {
  if (
    fingerprint?.[0] !== "agent-online" ||
    fingerprint.length > 4 ||
    !fingerprint.every(
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 64 &&
        /^[A-Za-z0-9_.-]+$/.test(value),
    )
  ) {
    return undefined;
  }
  return fingerprint;
}

export function shouldReportDiagnosticToSentry(event: DiagnosticEvent) {
  if (event.event === "request.unhandled") {
    return false;
  }
  if (event.errorCode) {
    return diagnosticErrorDefinitions[event.errorCode].severity === "error";
  }
  return event.outcome === "failed";
}

export function toSentryDiagnostic(context: DiagnosticContext, event: DiagnosticEvent) {
  return {
    context: compactPrimitive({
      ...toCorrelationContext(context),
      ...toCorrelationContext(event),
      attempt: event.attempt,
      duration_ms: event.durationMs,
      input_tokens: event.inputTokens,
      model_request_count: event.modelRequestCount,
      output_tokens: event.outputTokens,
      sandbox_duration_ms: event.sandboxDurationMs,
      total_tokens: event.totalTokens,
      upstream_http_status: event.upstreamHttpStatus,
    }),
    fingerprint: [
      "agent-online",
      "diagnostic",
      event.errorCode ?? "UNCLASSIFIED",
      event.stage ?? "unknown",
    ],
    tags: compactPrimitive({
      "agent.runtime": event.agentRuntimeId,
      "diagnostic.code": event.errorCode,
      "diagnostic.event": event.event,
      "diagnostic.stage": event.stage,
      "failure.code": event.failureCode,
      "model.id": event.modelId,
      "run.status": event.runStatus,
      "sandbox.runtime": event.sandboxRuntimeId,
    }),
  };
}

function sanitizeException(exception: ErrorEvent["exception"]) {
  if (!exception) {
    return undefined;
  }

  return {
    ...exception,
    ...(exception.values
      ? {
          values: exception.values.map((value) => {
            const mechanism = value.mechanism
              ? {
                  ...(value.mechanism.handled === undefined
                    ? {}
                    : { handled: value.mechanism.handled }),
                  type: value.mechanism.type,
                }
              : undefined;

            return {
              ...(mechanism ? { mechanism } : {}),
              ...(value.stacktrace ? { stacktrace: sanitizeStacktrace(value.stacktrace) } : {}),
              ...(value.type ? { type: value.type } : {}),
              value: "Application exception",
            };
          }),
        }
      : {}),
  };
}

function sanitizeStacktrace(stacktrace: Stacktrace) {
  if (!stacktrace?.frames) {
    return stacktrace;
  }

  return {
    ...stacktrace,
    frames: stacktrace.frames.map((frame) => {
      const sanitized = { ...frame };
      delete sanitized.vars;
      return sanitized;
    }),
  };
}

function sanitizeTags(tags: ErrorEvent["tags"]) {
  if (!tags) {
    return undefined;
  }

  const sanitized = Object.fromEntries(
    Object.entries(tags).filter(
      ([key, value]) =>
        sentryTagKeys.has(key) &&
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
    ),
  );
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeContexts(contexts: ErrorEvent["contexts"]) {
  const agentOnline = contexts?.agent_online;
  if (!agentOnline || typeof agentOnline !== "object") {
    return undefined;
  }

  const sanitized = Object.fromEntries(
    Object.entries(agentOnline).filter(
      ([key, value]) =>
        sentryContextKeys.has(key) &&
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
    ),
  );

  return Object.keys(sanitized).length > 0 ? { agent_online: sanitized } : undefined;
}

function toCorrelationContext(context: DiagnosticContext) {
  return compactPrimitive({
    preview_session_id: context.previewSessionId,
    request_id: context.requestId,
    run_id: context.runId,
    terminal_session_id: context.terminalSessionId,
  });
}

type SentryPrimitive = boolean | number | string;

function compactPrimitive(
  record: Record<string, SentryPrimitive | undefined>,
): Record<string, SentryPrimitive> {
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, SentryPrimitive] => entry[1] !== undefined,
    ),
  );
}
