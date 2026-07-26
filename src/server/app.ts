import { Hono } from "hono";

import { createAuth } from "./auth";
import { getDeploymentPolicy } from "./deployment-policy";
import type { AppEnv } from "./env";
import { createWorkerModelGateway, modelGatewayEndpointPath } from "./model-gateway-service";
import { createProjectApi } from "./project-api";

export const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  c.header("x-request-id", c.get("requestId"));
  await next();
});

app.get("/api/health", (c) =>
  c.json({
    name: "agent-online",
    requestId: c.get("requestId"),
    status: "ok",
  }),
);

app.get("/api/capabilities", (c) =>
  c.json({
    runCreationEnabled: getDeploymentPolicy(c.env).runsEnabled,
  }),
);

app.post(modelGatewayEndpointPath, (c) => createWorkerModelGateway(c.env)(c.req.raw));

app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));

app.route("/api", createProjectApi());

app.notFound((c) => c.json({ error: "not_found", requestId: c.get("requestId") }, 404));

app.onError((error, c) => {
  console.error("Unhandled request error", {
    message: error instanceof Error ? error.message : String(error),
    requestId: c.get("requestId"),
  });

  return c.json({ error: "internal_error", requestId: c.get("requestId") }, 500);
});
