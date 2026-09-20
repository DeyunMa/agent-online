import type { DiagnosticEvent, DiagnosticReporter } from "../observability/contract";

/** Timings contain fixed labels and numeric facts only. Reporter failure is inert. */
export async function measureOperation<T>(
  reporter: DiagnosticReporter,
  labels: Omit<DiagnosticEvent, "event" | "durationMs" | "outcome">,
  operation: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let outcome: DiagnosticEvent["outcome"] = "failed";
  try {
    const value = await operation();
    outcome = "succeeded";
    return value;
  } finally {
    reportMeasurement(reporter, { ...labels, outcome, durationMs: performance.now() - started });
  }
}

export function reportMeasurement(
  reporter: DiagnosticReporter,
  event: Omit<DiagnosticEvent, "event">,
) {
  try {
    reporter.report({ ...event, event: "performance.measured" });
  } catch {
    // Diagnostics never change execution or mask the original failure.
  }
}
