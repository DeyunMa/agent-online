import { describe, expect, it, vi } from "vitest";

import { createStructuredDiagnosticReporter } from "./structured-reporter";

describe("structured diagnostic reporter", () => {
  it("emits only the typed event and inherited correlation context", () => {
    const sink = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const reporter = createStructuredDiagnosticReporter({ requestId: "request-1" }, sink);

    reporter.report({
      errorCode: "MODEL_UPSTREAM_REJECTED",
      event: "model_gateway.request_failed",
      modelId: "gemini-test",
      outcome: "failed",
      runId: "run-1",
      stage: "upstream_response",
      upstreamCategory: "rate_limited",
      upstreamHttpStatus: 429,
    });

    expect(sink.error).toHaveBeenCalledWith({
      errorCode: "MODEL_UPSTREAM_REJECTED",
      event: "model_gateway.request_failed",
      modelId: "gemini-test",
      outcome: "failed",
      product: "agent-online",
      requestId: "request-1",
      runId: "run-1",
      schemaVersion: 1,
      severity: "error",
      stage: "upstream_response",
      upstreamCategory: "rate_limited",
      upstreamHttpStatus: 429,
    });
    expect(JSON.stringify(sink.error.mock.calls)).not.toMatch(
      /prompt|authorization|providerRef|private-upstream-body/i,
    );
  });

  it("does not let a logging sink break product execution", () => {
    const reporter = createStructuredDiagnosticReporter(
      {},
      {
        error() {
          throw new Error("sink unavailable");
        },
        info() {
          throw new Error("sink unavailable");
        },
        warn() {
          throw new Error("sink unavailable");
        },
      },
    );

    expect(() =>
      reporter.report({
        event: "agent_run.created",
        outcome: "succeeded",
        runId: "run-1",
      }),
    ).not.toThrow();
  });
});
