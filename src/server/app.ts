import { sentry } from "@sentry/hono/cloudflare";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";

import { defaultAgentRuntimeId, installedAgentRuntimeIds } from "../agent/registry";
import { createAuth } from "./auth";
import { createMcpApi } from "./mcp/api";
import { createMcpConnectionsApi } from "./mcp/connections";
import { createChangesApi } from "./changes-api";
import { getDeploymentPolicy } from "./deployment-policy";
import type { AppEnv } from "./env";
import { renderApiError } from "./http/api-errors";
import { requestMeasurement } from "./observability/request-measurement";
import { productRequestGuard } from "./http/product-request-guard";
import { createWorkerModelGateway, modelGatewayEndpointPath } from "./model-gateway-service";
import { createProjectApi } from "./project-api";
import { createPreviewApi } from "./preview-api";
import { getInstalledSandboxRuntimeId } from "./runtime-config";
import { createTerminalApi } from "./terminal-api";
import { createUsageApi } from "./usage-api";
import { createDiagnosticReporter } from "./observability/reporter";
import { captureServerException, createServerSentryOptions } from "./observability/sentry";

export const app = new Hono<AppEnv>();

app.use(
  sentry(app, (env) => ({
    ...createServerSentryOptions(env),
    shouldHandleError: () => false,
  })),
);
app.use("*", async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  c.header("x-request-id", c.get("requestId"));
  await next();
});
app.use("/api/*", requestMeasurement());
app.use("/mcp", requestMeasurement());
app.use(
  "/api/*",
  secureHeaders({
    crossOriginResourcePolicy: false,
  }),
);
app.use("/api/*", productRequestGuard());

app.get("/api/health", (c) =>
  c.json({
    name: "agent-online",
    requestId: c.get("requestId"),
    status: "ok",
  }),
);

app.get("/api/capabilities", (c) => {
  const sandboxRuntimeId = getInstalledSandboxRuntimeId(c.env);
  return c.json({
    agentRuntimeIds: [...installedAgentRuntimeIds],
    changesEnabled: sandboxRuntimeId === "e2b",
    defaultAgentRuntimeId,
    fileUploadEnabled: sandboxRuntimeId === "e2b",
    runCreationEnabled: getDeploymentPolicy(c.env).runsEnabled,
    previewEnabled: sandboxRuntimeId === "e2b",
    terminalEnabled: sandboxRuntimeId === "e2b",
  });
});

app.post(modelGatewayEndpointPath, (c) =>
  createWorkerModelGateway(c.env, { requestId: c.get("requestId") })(c.req.raw),
);

app.use(
  "/api/auth/oauth2/*",
  bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "request.too_large" }, 413) }),
);
app.use("/api/auth/oauth2/*", async (c, next) => {
  const registering = c.req.path === "/api/auth/oauth2/register";
  const limiter = registering ? c.env.MCP_REGISTRATION_LIMIT : c.env.MCP_RATE_LIMIT;
  if (!limiter) return c.json({ error: "oauth.unavailable" }, 503);
  const key = `oauth:${c.req.header("cf-connecting-ip") ?? "local"}`;
  if (!(await limiter.limit({ key })).success) {
    c.header("Retry-After", "60");
    return c.json({ error: "rate_limited" }, 429);
  }
  await next();
});

app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));

app.route("/api", createProjectApi());
app.route("/", createMcpApi());
app.route("/api", createMcpConnectionsApi());
app.route("/api", createChangesApi());
app.route("/api", createUsageApi());
app.route("/api", createTerminalApi());
app.route("/api", createPreviewApi());

app.notFound((c) => renderApiError(c, "resource.not_found"));

app.onError((error, c) => {
  const requestId = c.get("requestId");
  createDiagnosticReporter({ requestId }).report({
    errorCode: "UNEXPECTED",
    event: "request.unhandled",
    outcome: "failed",
    stage: "request",
  });
  captureServerException(error, { requestId });

  return renderApiError(c, "internal.unexpected");
});
