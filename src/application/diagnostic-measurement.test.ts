import { describe, expect, it, vi } from "vitest";
import { measureOperation } from "./diagnostic-measurement";

describe("operation measurement", () => {
  it("preserves the result and emits a numeric duration", async () => {
    const report = vi.fn();
    const result = { value: 1 };
    expect(
      await measureOperation(
        { report },
        { stage: "ensure_sandbox", runId: "run-1" },
        async () => result,
      ),
    ).toBe(result);
    expect(report).toHaveBeenCalledWith({
      event: "performance.measured",
      stage: "ensure_sandbox",
      runId: "run-1",
      outcome: "succeeded",
      durationMs: expect.any(Number),
    });
    expect(report.mock.calls[0]?.[0].durationMs).toBeGreaterThanOrEqual(0);
  });
  it("never masks the original operation failure with reporter failure", async () => {
    const failure = new Error("private upstream data");
    const report = vi.fn(() => {
      throw new Error("reporter failed");
    });
    await expect(
      measureOperation({ report }, { stage: "start_agent" }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(report).toHaveBeenCalledWith({
      event: "performance.measured",
      stage: "start_agent",
      outcome: "failed",
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain("private upstream data");
  });
  it("keeps successful operations successful if reporting fails", async () => {
    expect(
      await measureOperation(
        {
          report: () => {
            throw new Error();
          },
        },
        {},
        async () => 42,
      ),
    ).toBe(42);
  });
});
