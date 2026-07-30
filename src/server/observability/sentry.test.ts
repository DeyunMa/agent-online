import type { ErrorEvent } from "@sentry/cloudflare";
import { describe, expect, it } from "vitest";

import {
  createServerSentryOptions,
  sanitizeSentryEvent,
  shouldReportDiagnosticToSentry,
  toSentryDiagnostic,
} from "./sentry";

describe("server Sentry adapter", () => {
  it("is disabled without a DSN and disables content-bearing collection", () => {
    const options = createServerSentryOptions({ SENTRY_ENVIRONMENT: "test" });

    expect(options.enabled).toBe(false);
    expect(options.environment).toBe("test");
    expect(options.enableLogs).toBe(false);
    expect(options.enableMetrics).toBe(false);
    expect(options.dataCollection).toMatchObject({
      cookies: false,
      databaseQueryData: false,
      genAI: { inputs: false, outputs: false },
      httpBodies: [],
      httpHeaders: { request: false, response: false },
      stackFrameVariables: false,
      urlQueryParams: false,
      userInfo: false,
    });
  });

  it("keeps stack locations and approved correlation while removing content", () => {
    const sanitized = sanitizeSentryEvent({
      breadcrumbs: [{ message: "private prompt" }],
      contexts: {
        agent_online: {
          request_id: "request-1",
          secret_value: "private context",
        },
        runtime: {
          name: "private runtime context",
        },
      },
      exception: {
        values: [
          {
            mechanism: {
              data: { source: "private provider response" },
              handled: true,
              type: "generic",
            },
            stacktrace: {
              frames: [
                {
                  filename: "src/server/app.ts",
                  function: "handler",
                  lineno: 42,
                  vars: { prompt: "private prompt" },
                },
              ],
            },
            type: "ProviderError",
            value: "private provider response",
          },
        ],
      },
      extra: { prompt: "private prompt" },
      message: "private provider response",
      request: {
        cookies: { session: "private cookie" },
        data: "private request body",
        headers: { authorization: "private token" },
        url: "https://example.test/projects/private-id?prompt=private",
      },
      tags: {
        "diagnostic.code": "SANDBOX_PROCESS_FAILED",
        "private.tag": "private value",
      },
      type: undefined,
      user: { email: "private@example.test", id: "user-1" },
    } as ErrorEvent);

    expect(sanitized).toMatchObject({
      contexts: {
        agent_online: {
          request_id: "request-1",
        },
      },
      exception: {
        values: [
          {
            mechanism: {
              handled: true,
              type: "generic",
            },
            stacktrace: {
              frames: [
                {
                  filename: "src/server/app.ts",
                  function: "handler",
                  lineno: 42,
                },
              ],
            },
            type: "ProviderError",
            value: "Application exception",
          },
        ],
      },
      logger: "agent-online",
      message: "Agent Online application error",
      tags: {
        "diagnostic.code": "SANDBOX_PROCESS_FAILED",
      },
      type: undefined,
    });
    expect(JSON.stringify(sanitized)).not.toMatch(
      /authorization|cookie|private|prompt|provider response|secret_value/i,
    );
    expect(sanitized.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars).toBeUndefined();
  });

  it("maps only error diagnostics and avoids duplicating unhandled request errors", () => {
    expect(
      shouldReportDiagnosticToSentry({
        event: "agent_run.created",
        outcome: "succeeded",
        runId: "run-1",
      }),
    ).toBe(false);
    expect(
      shouldReportDiagnosticToSentry({
        errorCode: "UNEXPECTED",
        event: "request.unhandled",
        outcome: "failed",
        stage: "request",
      }),
    ).toBe(false);

    const event = {
      agentRuntimeId: "pi",
      errorCode: "SANDBOX_PROCESS_FAILED",
      event: "agent_run.stage_failed",
      outcome: "failed",
      runId: "run-1",
      sandboxRuntimeId: "e2b",
      stage: "start_agent",
    } as const;
    expect(shouldReportDiagnosticToSentry(event)).toBe(true);
    expect(toSentryDiagnostic({ requestId: "request-1" }, event)).toEqual({
      context: {
        request_id: "request-1",
        run_id: "run-1",
      },
      fingerprint: ["agent-online", "diagnostic", "SANDBOX_PROCESS_FAILED", "start_agent"],
      tags: {
        "agent.runtime": "pi",
        "diagnostic.code": "SANDBOX_PROCESS_FAILED",
        "diagnostic.event": "agent_run.stage_failed",
        "diagnostic.stage": "start_agent",
        "sandbox.runtime": "e2b",
      },
    });
  });
});
