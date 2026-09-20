import { expect, it, vi } from "vitest";
import { measureD1 } from "./measure-d1";
import { result } from "./d1-test-database";

it("sums batch execution costs without logging SQL, rows or bindings", async () => {
  const report = vi.fn();
  const first = result([{ content: "private" }]);
  first.meta.rows_read = 100;
  first.meta.rows_written = 0;
  const second = result();
  second.meta.rows_read = 23;
  second.meta.rows_written = 1;
  const batch = [first, second];
  expect(await measureD1({ report }, "usage_summary", async () => batch)).toBe(batch);
  expect(report).toHaveBeenCalledWith({
    event: "performance.measured",
    operation: "usage_summary",
    outcome: "succeeded",
    durationMs: expect.any(Number),
    rowsRead: 123,
    rowsWritten: 1,
  });
  expect(JSON.stringify(report.mock.calls)).not.toContain("private");
});

it("does not report missing metadata as a measured zero", async () => {
  const report = vi.fn();
  await measureD1({ report }, "run_history", async () => result());
  expect(report.mock.calls[0]?.[0]).not.toHaveProperty("rowsRead");
});

it("preserves query failures even when diagnostics throw", async () => {
  const error = new Error("private SQL failure");
  const report = vi.fn(() => {
    throw new Error();
  });
  await expect(
    measureD1({ report }, "run_history", async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(report).toHaveBeenCalledWith({
    event: "performance.measured",
    operation: "run_history",
    outcome: "failed",
    durationMs: expect.any(Number),
  });
});
