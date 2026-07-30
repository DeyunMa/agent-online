import * as Sentry from "@sentry/react";
import type { ErrorEvent, Stacktrace } from "@sentry/react";

export function initializeClientObservability() {
  const dsn = import.meta.env.VITE_SENTRY_DSN?.trim();
  if (!dsn) {
    return;
  }

  Sentry.init({
    beforeBreadcrumb: () => null,
    beforeSend: sanitizeClientSentryEvent,
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
    dsn,
    enableLogs: false,
    enableMetrics: false,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? "development",
    maxBreadcrumbs: 0,
    replaysOnErrorSampleRate: 0,
    replaysSessionSampleRate: 0,
    sampleRate: 1,
  });
}

export function sanitizeClientSentryEvent(event: ErrorEvent): ErrorEvent {
  const exception = sanitizeException(event.exception);

  return {
    ...(event.debug_meta ? { debug_meta: event.debug_meta } : {}),
    ...(event.environment ? { environment: event.environment } : {}),
    ...(event.event_id ? { event_id: event.event_id } : {}),
    ...(exception ? { exception } : {}),
    ...(event.level ? { level: event.level } : {}),
    ...(event.platform ? { platform: event.platform } : {}),
    ...(event.release ? { release: event.release } : {}),
    ...(event.sdk ? { sdk: event.sdk } : {}),
    ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    logger: "agent-online-client",
    message: "Agent Online client error",
    type: event.type,
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
              value: "Client application exception",
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
