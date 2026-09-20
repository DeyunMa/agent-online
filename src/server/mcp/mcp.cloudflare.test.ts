import { env } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Hono } from "hono";
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { createAuth } from "../auth";
import type { AppBindings, AppEnv } from "../env";
import { productRequestGuard } from "../http/product-request-guard";
import { D1AgentRunRepository } from "../persistence/d1-agent-run-repository";
import { createMcpApi } from "./api";
import { fetchTrustedClientMetadata } from "./cimd";
import { createMcpConnectionsApi } from "./connections";

const origin = "https://mcp.test";
const resource = `${origin}/mcp`;
const bindings = {
  ...env,
  MCP_RATE_LIMIT: { limit: async () => ({ success: true }) },
  BETTER_AUTH_URL: origin,
  BETTER_AUTH_SECRET: crypto.randomUUID(),
  ACCESS_MODE: "open",
} as AppBindings;
const app = new Hono<AppEnv>();
app.use("/api/*", productRequestGuard());
app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));
app.route("/", createMcpApi());
app.route("/api", createMcpConnectionsApi());
const request = (path: string, init?: RequestInit) =>
  app.request(`${origin}${path}`, init, bindings);

async function authorize(metadataClientId?: string, clientAssertion?: () => Promise<string>) {
  const email = `mcp-${crypto.randomUUID()}@example.test`;
  const signup = await request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ email, name: "MCP tester", password: crypto.randomUUID() }),
  });
  expect(signup.status).toBe(200);
  const user = (await signup.json()) as { user: { id: string } };
  const cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const registration = metadataClientId
    ? null
    : await request("/api/auth/oauth2/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "MCP verification",
          redirect_uris: ["http://127.0.0.1:34567/callback"],
          token_endpoint_auth_method: "none",
          application_type: "native",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "insights:read offline_access",
        }),
      });
  if (registration) expect(registration.status, await registration.clone().text()).toBe(201);
  const client = registration
    ? ((await registration.json()) as { client_id: string })
    : { client_id: metadataClientId ?? "" };
  const verifier = "test-verifier-with-at-least-forty-three-characters-123456789";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: "http://127.0.0.1:34567/callback",
    response_type: "code",
    scope: "insights:read offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "test-state",
    resource,
  });
  const authorization = await request(`/api/auth/oauth2/authorize?${params}`, {
    headers: { Cookie: cookie, Accept: "application/json" },
  });
  expect(authorization.status, authorization.ok ? "" : await authorization.clone().text()).toBe(
    200,
  );
  const consentUrl = ((await authorization.json()) as { url: string }).url;
  const consent = await request("/api/auth/oauth2/consent", {
    method: "POST",
    headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      accept: true,
      oauth_query: new URL(consentUrl, origin).search.slice(1),
    }),
  });
  expect(consent.status).toBe(200);
  const callback = new URL(((await consent.json()) as { url: string }).url);
  expect(callback.searchParams.get("state")).toBe("test-state");
  expect(callback.searchParams.get("iss")).toBe(`${origin}/api/auth`);
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.client_id,
    redirect_uri: "http://127.0.0.1:34567/callback",
    code: callback.searchParams.get("code") ?? "",
    code_verifier: verifier,
    resource,
  });
  if (clientAssertion) {
    tokenBody.set(
      "client_assertion_type",
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    );
    tokenBody.set("client_assertion", await clientAssertion());
  }
  const tokenResponse = await request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody,
  });
  expect(tokenResponse.status).toBe(200);
  const tokens = (await tokenResponse.json()) as { access_token: string; refresh_token: string };
  return { tokens, clientId: client.client_id, userId: user.user.id, tokenBody, cookie };
}

describe("MCP OAuth and real D1 protocol", () => {
  it("reuses fresh CIMD metadata across separate auth requests", async () => {
    const clientId = "https://chatgpt.com/oauth/cache-test/client.json";
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        {
          client_id: clientId,
          client_name: "Cached CIMD",
          redirect_uris: ["http://127.0.0.1:34567/callback"],
          application_type: "native",
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        },
        { headers: { "Cache-Control": "public, max-age=3600" } },
      ),
    );
    try {
      await authorize(clientId);
      await authorize(clientId);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("shares CIMD in-flight work and fetch budgets across request-created auth instances", async () => {
    const testOrigin = "https://budget.mcp.test";
    const isolated = { ...bindings, BETTER_AUTH_URL: testOrigin };
    const discover = (index: number) =>
      createAuth(isolated).handler(
        new Request(
          `${testOrigin}/api/auth/oauth2/authorize?${new URLSearchParams({
            client_id: `https://chatgpt.com/oauth/budget-${index}/client.json`,
            redirect_uri: "http://127.0.0.1:34567/callback",
            response_type: "code",
            scope: "insights:read",
            code_challenge: "a".repeat(43),
            code_challenge_method: "S256",
            resource: `${testOrigin}/mcp`,
            state: "budget-test",
          })}`,
          { headers: { Accept: "application/json" } },
        ),
      );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      entered();
      await gate;
      return Response.json(
        {
          client_id: String(input),
          client_name: "Budget CIMD",
          redirect_uris: ["http://127.0.0.1:34567/callback"],
          application_type: "native",
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    });
    try {
      const concurrent = Array.from({ length: 5 }, () => discover(0));
      await started;
      release();
      for (const response of await Promise.all(concurrent)) expect(response.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      for (let i = 1; i < 30; i++) expect((await discover(i)).status).toBe(200);
      const denied = await discover(30);
      expect(denied.status).toBeGreaterThanOrEqual(400);
      expect(spy).toHaveBeenCalledTimes(30);
    } finally {
      release();
      spy.mockRestore();
    }
  });

  // Known upstream 1.7.5 regression: remove .fails only after a fixed release.
  // Pause the real adapter precisely after rotation CAS and before successor INSERT.
  it.fails.each(["connection", "upstream"] as const)(
    "blocks the in-flight refresh successor after %s revocation (upstream regression)",
    async (mode) => {
      const own = await authorize();
      const auth = createAuth(bindings);
      const context = await auth.$context;
      const create = context.adapter.create.bind(context.adapter);
      let reached!: () => void;
      const paused = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let resume!: () => void;
      const released = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const spy = vi.spyOn(context.adapter, "create").mockImplementation(async (input) => {
        if (input.model === "oauthRefreshToken") {
          reached();
          await released;
        }
        return create(input);
      });
      const refreshRequest = (token: string) =>
        new Request(`${origin}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: own.clientId,
            refresh_token: token,
            resource,
          }),
        });
      const inflight = auth.handler(refreshRequest(own.tokens.refresh_token));
      try {
        await paused;
        if (mode === "connection") {
          const consent = await env.DB.prepare("SELECT id FROM oauthConsent WHERE userId=?")
            .bind(own.userId)
            .first<{ id: string }>();
          expect(consent).not.toBeNull();
          expect(
            (
              await request(`/api/mcp/connections/${consent?.id}/revoke`, {
                method: "POST",
                headers: { Cookie: own.cookie, Origin: origin },
              })
            ).status,
          ).toBe(200);
        } else {
          // Original token is already marked rotated. The provider deletes its family.
          expect(
            (
              await request("/api/auth/oauth2/revoke", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                  client_id: own.clientId,
                  token: own.tokens.refresh_token,
                  token_type_hint: "refresh_token",
                }),
              })
            ).status,
          ).toBe(400);
        }
        expect(
          await env.DB.prepare("SELECT id FROM oauthRefreshToken WHERE userId=?")
            .bind(own.userId)
            .first(),
        ).toBeNull();
      } finally {
        resume();
        spy.mockRestore();
      }
      const response = await inflight;
      expect(response.status).toBe(200);
      const tokens = (await response.json()) as { refresh_token: string };
      const renewed = await createAuth(bindings).handler(refreshRequest(tokens.refresh_token));
      // 1.7.5 returns 200 here: revocation did not survive the late INSERT.
      expect(renewed.status).toBe(400);
    },
  );

  it("accepts signed CIMD clients using a separately fetched approved JWKS", async () => {
    const clientId = "https://chatgpt.com/oauth/signed-test/client.json";
    const pair = await generateKeyPair("RS256");
    const jwk = await exportJWK(pair.publicKey);
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === "https://chatgpt.com/oauth/jwks.json")
        return Response.json({ keys: [{ ...jwk, kid: "test", alg: "RS256", use: "sig" }] });
      expect(String(input)).toBe(clientId);
      return Response.json({
        client_id: clientId,
        client_name: "Signed CIMD",
        redirect_uris: ["http://127.0.0.1:34567/callback"],
        application_type: "native",
        token_endpoint_auth_method: "private_key_jwt",
        token_endpoint_auth_signing_alg: "RS256",
        jwks_uri: "https://chatgpt.com/oauth/jwks.json",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
    });
    try {
      const result = await authorize(clientId, () =>
        new SignJWT({})
          .setProtectedHeader({ alg: "RS256", kid: "test" })
          .setIssuer(clientId)
          .setSubject(clientId)
          .setAudience(`${origin}/api/auth/oauth2/token`)
          .setJti(crypto.randomUUID())
          .setIssuedAt()
          .setExpirationTime("2m")
          .sign(pair.privateKey),
      );
      expect(decodeJwt(result.tokens.access_token).aud).toBe(resource);
    } finally {
      spy.mockRestore();
    }
  });
  it("resolves CIMD through the trusted transport and binds its metadata to PKCE", async () => {
    const clientId = "https://chatgpt.com/oauth/client.json";
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(String(input)).toBe(clientId);
      return Response.json({
        client_id: clientId,
        client_name: "CIMD test",
        redirect_uris: ["http://127.0.0.1:34567/callback"],
        application_type: "native",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "insights:read offline_access",
      });
    });
    try {
      expect((await fetchTrustedClientMetadata(clientId)).status).toBe(200);
      const { tokens } = await authorize(clientId);
      expect(decodeJwt(tokens.access_token).aud).toBe(resource);
      const client = await env.DB.prepare(
        "SELECT clientDiscoveryId FROM oauthClient WHERE clientId=?",
      )
        .bind(clientId)
        .first();
      expect(client).toMatchObject({ clientDiscoveryId: "cimd" });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
  it("lists only own consents and revokes renewal without touching another user", async () => {
    const own = await authorize();
    const other = await authorize();
    const response = await request("/api/mcp/connections", { headers: { Cookie: own.cookie } });
    expect(response.headers.get("cache-control")).toContain("no-store");
    const list = (await response.json()) as { items: { id: string; clientId: string }[] };
    expect(list.items.map((x) => x.clientId)).toEqual([own.clientId]);
    const id = list.items[0]?.id;
    if (!id) throw new Error("Missing test consent");
    expect(
      (
        await request(`/api/mcp/connections/${id}/revoke`, {
          method: "POST",
          headers: { Cookie: own.cookie, Origin: "https://evil.test" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`/api/mcp/connections/${id}/revoke`, {
          method: "POST",
          headers: { Cookie: other.cookie, Origin: origin },
        })
      ).status,
    ).toBe(200);
    expect(
      await env.DB.prepare("SELECT id FROM oauthConsent WHERE id=?").bind(id).first(),
    ).not.toBeNull();
    expect(
      (
        await request(`/api/mcp/connections/${id}/revoke`, {
          method: "POST",
          headers: { Cookie: own.cookie, Origin: origin },
        })
      ).status,
    ).toBe(200);
    const refresh = await request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: own.clientId,
        refresh_token: own.tokens.refresh_token,
        resource,
      }),
    });
    expect(refresh.status).toBe(400);
    expect(
      await env.DB.prepare("SELECT id FROM oauthConsent WHERE userId=?").bind(other.userId).first(),
    ).not.toBeNull();
  });
  it("rejects token audience, scope, expiry and changed deployment membership", async () => {
    const { tokens } = await authorize();
    const claims = decodeJwt(tokens.access_token);
    for (const change of [
      { aud: "https://another-resource.test" },
      { scope: "offline_access" },
      { exp: 1 },
    ]) {
      const { token } = await createAuth(bindings).api.signJWT({
        body: { payload: { ...claims, ...change } },
      });
      expect(
        (await request("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}` } }))
          .status,
      ).toBe("scope" in change ? 403 : 401);
    }
    const blocked = await app.request(
      resource,
      { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}` } },
      {
        ...bindings,
        ACCESS_MODE: "allowlist",
        ACCESS_ALLOWED_EMAILS: `${crypto.randomUUID()}@example.test`,
      },
    );
    expect(blocked.status).toBe(401);
  });
  it("bounds request size and rate, and fails closed when the limiter is missing", async () => {
    const large = await request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(65537),
    });
    expect(large.status).toBe(413);
    const limited = await app.request(
      resource,
      { method: "POST" },
      { ...bindings, MCP_RATE_LIMIT: { limit: async () => ({ success: false }) } },
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    const { MCP_RATE_LIMIT: _limiter, ...withoutLimiter } = bindings;
    expect((await app.request(resource, { method: "POST" }, withoutLimiter)).status).toBe(503);
  });
  it("advertises discovery, rejects missing/bad tokens and foreign origins", async () => {
    const response = await request("/mcp", { method: "POST" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
    const metadata = (await (
      await request("/.well-known/oauth-authorization-server/api/auth")
    ).json()) as Record<string, unknown>;
    expect(metadata.issuer).toBe(`${origin}/api/auth`);
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    expect(metadata.client_id_metadata_document_supported).toBe(true);
    expect(response.headers.get("www-authenticate")).not.toContain("offline_access");
    expect(await (await request("/.well-known/oauth-protected-resource/mcp")).json()).toMatchObject(
      { scopes_supported: ["insights:read"] },
    );
    expect(
      (await request("/mcp", { method: "POST", headers: { Authorization: "Bearer invalid" } }))
        .status,
    ).toBe(401);
    expect(
      (await request("/mcp", { method: "POST", headers: { Origin: "https://untrusted.test" } }))
        .status,
    ).toBe(403);
  });
  it("completes PKCE, discovers tools and reads D1 with ownership isolation, refresh and revocation", async () => {
    const { tokens, clientId, userId, tokenBody } = await authorize();
    await env.DB.prepare(
      "INSERT INTO projects (id,user_id,title,default_agent_runtime_id,created_at,updated_at) VALUES (?,?,'MCP evidence','pi',?,?)",
    )
      .bind(`project-${userId}`, userId, "2026-09-20T00:00:00.000Z", "2026-09-20T00:00:00.000Z")
      .run();
    const other = await authorize();
    await env.DB.prepare(
      "INSERT INTO projects (id,user_id,title,default_agent_runtime_id,created_at,updated_at) VALUES (?,?,'PRIVATE OTHER TITLE','pi',?,?)",
    )
      .bind(
        `project-${other.userId}`,
        other.userId,
        "2026-09-20T00:00:00.000Z",
        "2026-09-20T00:00:00.000Z",
      )
      .run();
    const runs = new D1AgentRunRepository(env.DB);
    for (const owner of [userId, other.userId]) {
      await env.DB.prepare(
        "INSERT INTO sandbox_leases (id,project_id,sandbox_runtime_id,status,created_at,updated_at) VALUES (?,?,'fake','stopped',?,?)",
      )
        .bind(
          `lease-${owner}`,
          `project-${owner}`,
          "2026-09-20T00:00:00.000Z",
          "2026-09-20T00:00:00.000Z",
        )
        .run();
      const queued = await runs.createQueuedWithInput({
        agentRunId: `run-${owner}`,
        agentRuntimeId: "pi",
        content: "PRIVATE PROMPT",
        inputMessageId: `message-${owner}`,
        modelId: "test-model",
        now: "2026-09-20T00:00:00.000Z",
        projectId: `project-${owner}`,
        sandboxLeaseId: `lease-${owner}`,
        sandboxRuntimeId: "fake",
        userId: owner,
      });
      expect(queued.kind).toBe("created");
      await runs.transition({
        runId: `run-${owner}`,
        from: "queued",
        to: "cancelled",
        finishedAt: "2026-09-20T00:00:01.000Z",
      });
    }
    await env.DB.prepare(
      "UPDATE agent_runs SET input_tokens=10,output_tokens=5,total_tokens=15,model_request_count=1,sandbox_duration_ms=1000,provider_process_ref='PRIVATE PROCESS' WHERE id=?",
    )
      .bind(`run-${userId}`)
      .run();
    await env.DB.prepare(
      "INSERT INTO archived_run_usage (run_id,user_id,project_id,project_title,agent_runtime_id,sandbox_runtime_id,model_id,status,input_tokens,output_tokens,total_tokens,model_request_count,sandbox_duration_ms,created_at,started_at,finished_at,deleted_at) VALUES (?,?,?,'Deleted test Project','pi','fake','test-model','cancelled',20,10,30,2,2000,?,NULL,?,?)",
    )
      .bind(
        `archived-${userId}`,
        userId,
        `deleted-${userId}`,
        "2026-09-19T00:00:00.000Z",
        "2026-09-19T00:00:02.000Z",
        "2026-09-20T00:00:00.000Z",
      )
      .run();
    const client = new Client({ name: "agent-online-verification", version: "1.0.0" });
    // SDK 1.30 declares sessionId inconsistently with exactOptionalPropertyTypes.
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
        fetch: async (input, init) => app.fetch(new Request(input, init), bindings),
      }) as Transport,
    );
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "get_system_context",
      "list_projects",
      "get_usage_summary",
      "list_runs",
      "get_run_summary",
    ]);
    for (const tool of tools.tools) expect(tool.annotations?.readOnlyHint).toBe(true);
    const projects = await client.callTool({ name: "list_projects", arguments: {} });
    expect(projects.isError).not.toBe(true);
    expect(projects.structuredContent).toMatchObject({
      items: [{ id: `project-${userId}`, title: "MCP evidence" }],
    });
    const usage = await client.callTool({ name: "get_usage_summary", arguments: {} });
    expect(usage.structuredContent).toMatchObject({
      scope: "all_time",
      totals: { runCount: 2, totalTokens: 45, modelRequestCount: 3, sandboxDurationMs: 3000 },
    });
    const own = await client.callTool({
      name: "get_run_summary",
      arguments: { projectId: `project-${userId}`, runId: `run-${userId}` },
    });
    expect(own.structuredContent).toMatchObject({
      id: `run-${userId}`,
      status: "cancelled",
      usage: { totalTokens: 15 },
    });
    const listed = await client.callTool({
      name: "list_runs",
      arguments: { projectId: `project-${userId}` },
    });
    expect(listed.structuredContent).toMatchObject({
      items: [{ id: `run-${userId}` }],
      nextCursor: null,
    });
    for (const output of [projects, usage, own, listed]) {
      const serialized = JSON.stringify(output);
      for (const forbidden of [
        "PRIVATE PROMPT",
        "PRIVATE PROCESS",
        "PRIVATE OTHER TITLE",
        "providerProcessRef",
        "inputMessageId",
        "modelAdmission",
        "userId",
      ])
        expect(serialized).not.toContain(forbidden);
    }
    expect(
      (
        await client.callTool({
          name: "list_runs",
          arguments: { projectId: `project-${other.userId}` },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: "get_run_summary",
          arguments: { projectId: `project-${userId}`, runId: `run-${other.userId}` },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: "get_run_summary",
          arguments: { projectId: `project-${other.userId}`, runId: `run-${other.userId}` },
        })
      ).isError,
    ).toBe(true);
    const inaccessible = await client.callTool({
      name: "get_run_summary",
      arguments: { projectId: "other-project", runId: "other-run" },
    });
    expect(inaccessible.isError).toBe(true);
    const invalid = await client.callTool({
      name: "list_projects",
      arguments: { cursor: { id: "x", at: "not-a-date" } },
    });
    expect(invalid.isError).toBe(true);
    const refreshed = await request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: tokens.refresh_token,
        resource,
      }),
    });
    expect(refreshed.status).toBe(200);
    const fresh = (await refreshed.json()) as { refresh_token: string };
    expect(
      (
        await request("/api/auth/oauth2/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            token: fresh.refresh_token,
            token_type_hint: "refresh_token",
          }),
        })
      ).status,
    ).toBe(200);
    const revoked = await request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: fresh.refresh_token,
        resource,
      }),
    });
    expect(revoked.status).toBe(400);
    const replay = await request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });
    expect(replay.status).toBe(400);
    await client.close();
  });
});
