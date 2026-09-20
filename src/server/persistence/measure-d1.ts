import type { DiagnosticReporter } from "../../observability/contract";
import { reportMeasurement } from "../../application/diagnostic-measurement";

/** Aggregate D1 execution metadata only; never report SQL, bindings, or returned rows. */
export async function measureD1<T extends D1Result | D1Result[]>(
  reporter: DiagnosticReporter,
  operation: "run_history" | "usage_summary",
  query: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let result: T | undefined;
  try {
    result = await query();
    return result;
  } finally {
    const results: D1Result[] =
      result === undefined ? [] : Array.isArray(result) ? result : [result];
    const rowsRead = results.reduce((sum, item) => sum + (item.meta?.rows_read ?? 0), 0);
    const rowsWritten = results.reduce((sum, item) => sum + (item.meta?.rows_written ?? 0), 0);
    reportMeasurement(reporter, {
      operation,
      durationMs: performance.now() - started,
      outcome: result === undefined ? "failed" : "succeeded",
      ...(results.length &&
      results.every(
        (item) => Number.isFinite(item.meta?.rows_read) && Number.isFinite(item.meta?.rows_written),
      )
        ? { rowsRead, rowsWritten }
        : {}),
    });
  }
}
