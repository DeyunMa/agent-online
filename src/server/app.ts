import { sentry } from "@sentry/hono/cloudflare";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

import { defaultAgentRuntimeId } from "../agent/registry";
import { getAgentRuntimePolicy } from "./agent-runtime-policy";
import { createAuth } from "./auth";
import { createChangesApi } from "./changes-api";
import { getDeploymentPolicy } from "./deployment-policy";
import type { AppEnv } from "./env";
import { renderApiError } from "./http/api-errors";
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
  const policy = getAgentRuntimePolicy(c.env, sandboxRuntimeId);
  return c.json({
    agentRuntimeIds: [...policy.publicRuntimeIds],
    changesEnabled: sandboxRuntimeId === "e2b",
    defaultAgentRuntimeId,
    runCreationEnabled: getDeploymentPolicy(c.env).runsEnabled,
    previewEnabled: sandboxRuntimeId === "e2b",
    terminalEnabled: sandboxRuntimeId === "e2b",
  });
});

app.post(modelGatewayEndpointPath, (c) =>
  createWorkerModelGateway(c.env, { requestId: c.get("requestId") })(c.req.raw),
);

app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));

app.route("/api", createProjectApi());
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
