import {
  type DiagnosticContext,
  type DiagnosticEvent,
  type DiagnosticReporter,
  diagnosticErrorDefinitions,
} from "../../observability/contract";

type DiagnosticLogRecord = DiagnosticEvent & {
  product: "agent-online";
  schemaVersion: 1;
  severity: "error" | "info" | "warn";
};

type DiagnosticSink = Pick<Console, "error" | "info" | "warn">;

export function createStructuredDiagnosticReporter(
  context: DiagnosticContext = {},
  sink: DiagnosticSink = console,
): DiagnosticReporter {
  return {
    report(event) {
      const severity = getSeverity(event);
      const record = compact({
        ...context,
        ...event,
        product: "agent-online" as const,
        schemaVersion: 1 as const,
        severity,
      }) as DiagnosticLogRecord;

      try {
        sink[severity](record);
      } catch {
        // Observability must never change product execution.
      }
    },
  };
}

function getSeverity(event: DiagnosticEvent) {
  if (event.errorCode) {
    return diagnosticErrorDefinitions[event.errorCode].severity;
  }
  if (event.outcome === "failed") {
    return "error";
  }
  if (event.outcome === "rejected") {
    return "warn";
  }
  return "info";
}

function compact<T extends Record<string, unknown>>(record: T) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
