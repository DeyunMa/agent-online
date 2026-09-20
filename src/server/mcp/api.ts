import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createLocalJWKSet, jwtVerify } from "jose";
import { ProjectInsightsService } from "../../application/project-insights";
import { ProjectReadService } from "../../application/project-read";
import { UserUsageService } from "../../application/user-usage";
import { createAuth } from "../auth";
import { getAuthConfig } from "../config";
import { getDeploymentPolicy, isEmailAllowed } from "../deployment-policy";
import type { AppBindings, AppEnv } from "../env";
import {
  D1AgentRunRepository,
  D1MessageRepository,
  D1ProjectRepository,
  D1SandboxLeaseRepository,
} from "../persistence/d1-repositories";
import { D1InsightsUsageRepository } from "../persistence/d1-insights-usage-repository";
import { createInsightsMcpServer } from "./server";
import { createDiagnosticReporter } from "../observability/reporter";

export function mcpResource(env: AppBindings) {
  return `${new URL(getAuthConfig(env).baseURL).origin}/mcp`;
}

export function createMcpApi() {
  const api = new Hono<AppEnv>();
  api.get("/.well-known/oauth-authorization-server/api/auth", (c) =>
    oauthProviderAuthServerMetadata(createAuth(c.env))(c.req.raw),
  );
  const resourceMetadata = (env: AppBindings) => ({
    resource: mcpResource(env),
    authorization_servers: [`${new URL(getAuthConfig(env).baseURL).origin}/api/auth`],
    scopes_supported: ["insights:read"],
    bearer_methods_supported: ["header"],
  });
  api.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(resourceMetadata(c.env)));
  api.get("/.well-known/oauth-protected-resource", (c) => c.json(resourceMetadata(c.env)));
  api.use(
    "/mcp",
    bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "request.too_large" }, 413) }),
  );
  api.all("/mcp", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const resource = mcpResource(c.env);
    if (!c.env.MCP_RATE_LIMIT) return c.json({ error: "mcp.unavailable" }, 503);
    if (
      !(
        await c.env.MCP_RATE_LIMIT.limit({
          key: `mcp-ip:${c.req.header("cf-connecting-ip") ?? "local"}`,
        })
      ).success
    ) {
      c.header("Retry-After", "60");
      return c.json({ error: "rate_limited" }, 429);
    }
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(resource).origin)
      return c.json({ error: "origin.forbidden" }, 403);
    const challenge = `Bearer resource_metadata="${new URL(resource).origin}/.well-known/oauth-protected-resource/mcp", scope="insights:read"`;
    const authentication = await authenticateMcp(c.env, c.req.header("authorization"));
    if (!authentication) {
      c.header("WWW-Authenticate", challenge);
      return c.json({ error: "invalid_token" }, 401);
    }
    if (!authentication.allowed) {
      c.header("WWW-Authenticate", `${challenge}, error="insufficient_scope"`);
      return c.json({ error: "insufficient_scope" }, 403);
    }
    const userId = authentication.userId;
    if (!(await c.env.MCP_RATE_LIMIT.limit({ key: `mcp-user:${userId}` })).success) {
      c.header("Retry-After", "60");
      return c.json({ error: "rate_limited" }, 429);
    }
    if (c.req.method !== "POST") {
      c.header("Allow", "POST");
      return c.json({ error: "method_not_allowed" }, 405);
    }
    const insights = new ProjectInsightsService(
      new ProjectReadService({
        agentRuns: new D1AgentRunRepository(c.env.DB),
        messages: new D1MessageRepository(c.env.DB),
        projects: new D1ProjectRepository(c.env.DB),
        sandboxLeases: new D1SandboxLeaseRepository(c.env.DB),
      }),
      new UserUsageService(new D1InsightsUsageRepository(c.env.DB)),
    );
    const requestId = c.get("requestId");
    const server = createInsightsMcpServer(
      insights,
      userId,
      createDiagnosticReporter(requestId ? { requestId } : {}),
    );
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });
  return api;
}

async function authenticateMcp(env: AppBindings, authorization: string | undefined) {
  if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) return null;
  try {
    const auth = createAuth(env);
    const jwks = await auth.api.getJwks();
    const { payload } = await jwtVerify(authorization.slice(7), createLocalJWKSet(jwks), {
      issuer: `${new URL(getAuthConfig(env).baseURL).origin}/api/auth`,
      audience: mcpResource(env),
      requiredClaims: ["exp", "iat", "sub"],
      algorithms: ["EdDSA"],
    });
    if (!payload.sub) return null;
    const user = await env.DB.prepare('SELECT email FROM "user" WHERE id = ?')
      .bind(payload.sub)
      .first<{ email: string }>();
    return user && isEmailAllowed(getDeploymentPolicy(env), user.email)
      ? {
          userId: payload.sub,
          allowed:
            typeof payload.scope === "string" && payload.scope.split(" ").includes("insights:read"),
        }
      : null;
  } catch {
    return null;
  }
}
