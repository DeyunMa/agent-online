import type { MiddlewareHandler } from "hono";
import type { DiagnosticEvent, DiagnosticReporter } from "../../observability/contract";
import { reportMeasurement } from "../../application/diagnostic-measurement";
import type { AppEnv } from "../env";
import { createDiagnosticReporter } from "./reporter";

/** Measures response setup, not the lifetime of SSE/WebSocket/streaming bodies. */
export function requestMeasurement(
  reporterFactory: (requestId: string) => DiagnosticReporter = (requestId) =>
    createDiagnosticReporter({ requestId }),
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = performance.now();
    await next();
    reportMeasurement(reporterFactory(c.get("requestId")), {
      operation: "http",
      stage: "request",
      route: classifyRoute(c.req.path),
      httpStatus: c.res.status,
      durationMs: performance.now() - started,
      outcome: c.res.status >= 500 ? "failed" : c.res.status >= 400 ? "rejected" : "succeeded",
    });
  };
}

export function classifyRoute(path: string): NonNullable<DiagnosticEvent["route"]> {
  if (path === "/mcp") return "mcp";
  if (path.startsWith("/api/auth/")) return "auth";
  if (path === "/api/usage") return "usage";
  if (path.includes("/model-gateway/")) return "model_gateway";
  if (/^\/api\/projects(?:\/|$)/u.test(path)) {
    const resource = path.split("/")[4];
    if (resource === "messages") return "messages";
    if (resource === "agent-runs") return "runs";
    if (resource === "files" || resource === "file") return "files";
    if (resource === "changes") return "changes";
    if (resource === "preview") return "preview";
    return "projects";
  }
  return "other";
}
