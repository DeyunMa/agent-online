import type { DiagnosticContext, DiagnosticReporter } from "../../observability/contract";
import { createSentryDiagnosticReporter } from "./sentry";
import { createStructuredDiagnosticReporter } from "./structured-reporter";

export function createDiagnosticReporter(context: DiagnosticContext = {}): DiagnosticReporter {
  const reporters = [
    createStructuredDiagnosticReporter(context),
    createSentryDiagnosticReporter(context),
  ];

  return {
    report(event) {
      for (const reporter of reporters) {
        try {
          reporter.report(event);
        } catch {
          // Observability must never change product execution.
        }
      }
    },
  };
}
