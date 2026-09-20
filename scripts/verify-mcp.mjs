/**
 * Real MCP/OAuth smoke probe. Usage: rtk proxy node scripts/verify-mcp.mjs --url HTTPS_ORIGIN/mcp
 * Requires an already deployed server and an interactive login/consent in a browser.
 * Creates one public OAuth client + consent, holds PKCE/tokens only in memory, reads
 * business data, then revokes its refresh token. No Project, Run or sandbox mutations.
 * Prints only the authorization URL and safe aggregate evidence. Ctrl-C closes the
 * loopback callback. An interrupted probe's access token expires within five minutes;
 * remove its consent from the authorization server if interrupted after token issuance.
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  UnauthorizedError,
  auth,
  discoverOAuthServerInfo,
  refreshAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";

const urlIndex = process.argv.indexOf("--url");
if (urlIndex < 0 || !process.argv[urlIndex + 1]) throw new Error("Pass --url HTTPS_ORIGIN/mcp");
const endpoint = new URL(process.argv[urlIndex + 1]);
if (
  endpoint.pathname !== "/mcp" ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  (endpoint.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(endpoint.hostname))
)
  throw new Error("Expected HTTPS /mcp endpoint or local loopback");
const state = randomBytes(32).toString("base64url");
let completeCallback;
const callbackCode = new Promise((resolve) => {
  completeCallback = resolve;
});
let authorizationIssuer;
const callback = createServer((req, res) => {
  const incoming = new URL(req.url, "http://127.0.0.1");
  if (
    incoming.pathname !== "/callback" ||
    incoming.searchParams.get("state") !== state ||
    incoming.searchParams.get("iss") !== authorizationIssuer ||
    !incoming.searchParams.get("code")
  ) {
    res.writeHead(400, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end("Invalid OAuth callback");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'",
  });
  res.end(
    "<h1>Agent Online MCP authorized</h1><p>The local verification client is checking the read-only tools. You can close this tab.</p>",
  );
  completeCallback(incoming.searchParams.get("code"));
});
await new Promise((resolve) => callback.listen(0, "127.0.0.1", resolve));
const redirectUrl = `http://127.0.0.1:${callback.address().port}/callback`;
let information, tokens, verifier;
const provider = {
  redirectUrl,
  clientMetadata: {
    client_name: "Agent Online MCP verification",
    redirect_uris: [redirectUrl],
    token_endpoint_auth_method: "none",
    application_type: "native",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "insights:read offline_access",
  },
  state: () => state,
  clientInformation: () => information,
  saveClientInformation: (value) => {
    information = value;
  },
  tokens: () => tokens,
  saveTokens: (value) => {
    tokens = value;
  },
  codeVerifier: () => verifier,
  saveCodeVerifier: (value) => {
    verifier = value;
  },
  redirectToAuthorization: (url) => {
    console.log(JSON.stringify({ stage: "authorize", authorizationUrl: url.toString() }));
  },
};
const client = new Client({ name: "agent-online-verification", version: "1.0.0" });
let transport = new StreamableHTTPClientTransport(endpoint, { authProvider: provider });
const timer = setTimeout(
  () => {
    console.error("OAuth verification timed out");
    callback.close();
    process.exitCode = 1;
  },
  10 * 60 * 1000,
);
timer.unref();
let metadata;
let refreshRevoked = false;
async function revoke() {
  if (refreshRevoked || !tokens?.refresh_token || !metadata?.revocation_endpoint) return;
  const response = await fetch(metadata.revocation_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: information.client_id,
      token: tokens.refresh_token,
      token_type_hint: "refresh_token",
    }),
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, 200, "Refresh-token revocation failed");
  refreshRevoked = true;
}
try {
  const discovery = await discoverOAuthServerInfo(endpoint);
  metadata = discovery.authorizationServerMetadata;
  authorizationIssuer = metadata.issuer;
  assert.equal(discovery.resourceMetadata.resource, endpoint.toString());
  // This verifier explicitly opts into renewal; offline_access is not an MCP resource requirement.
  const authResult = await auth(provider, {
    serverUrl: endpoint,
    scope: "insights:read offline_access",
  });
  if (authResult === "REDIRECT") {
    const code = await callbackCode;
    await transport.finishAuth(code);
  }
  try {
    await client.connect(transport);
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    const code = await callbackCode;
    await transport.finishAuth(code);
    transport = new StreamableHTTPClientTransport(endpoint, { authProvider: provider });
    await client.connect(transport);
  }
  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  assert.deepEqual(toolNames, [
    "get_system_context",
    "list_projects",
    "get_usage_summary",
    "list_runs",
    "get_run_summary",
  ]);
  assert.ok(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true));
  async function call(name, args = {}) {
    const output = await client.callTool({ name, arguments: args });
    assert.ok(!output.isError, `${name} returned an error`);
    assert.ok(output.structuredContent, `${name} missing structuredContent`);
    assert.equal(output.structuredContent.schemaVersion, 1);
    const serialized = JSON.stringify(output);
    for (const forbidden of [
      "provider_ref",
      "providerRef",
      "providerProcessRef",
      "inputMessageId",
      "modelAdmissionCount",
      "privateKey",
      "clientSecret",
    ])
      assert.ok(!serialized.includes(`"${forbidden}"`), "Private field leaked");
    return output.structuredContent;
  }
  const context = await call("get_system_context");
  const usage = await call("get_usage_summary");
  let projects = await call("list_projects");
  let runEvidence = null,
    examinedProjects = 0;
  for (let page = 0; page < 5 && !runEvidence; page++) {
    for (const project of projects.items) {
      if (examinedProjects++ >= 20) break;
      const runs = await call("list_runs", { projectId: project.id });
      if (runs.items.length) {
        const run = await call("get_run_summary", {
          projectId: project.id,
          runId: runs.items[0].id,
        });
        runEvidence = {
          status: run.status,
          modelId: run.modelId,
          usage: run.usage,
          failureCode: run.failureCode,
        };
        break;
      }
    }
    if (!projects.nextCursor || examinedProjects >= 20) break;
    projects = await call("list_projects", { cursor: projects.nextCursor });
  }
  const absent = await client.callTool({
    name: "get_run_summary",
    arguments: { projectId: "verification-missing-project", runId: "verification-missing-run" },
  });
  assert.equal(absent.isError, true);
  tokens = await refreshAuthorization(authorizationIssuer, {
    metadata,
    clientInformation: information,
    refreshToken: tokens.refresh_token,
    resource: endpoint,
  });
  await call("get_system_context");
  await revoke();
  let revoked = false;
  try {
    await refreshAuthorization(authorizationIssuer, {
      metadata,
      clientInformation: information,
      refreshToken: tokens.refresh_token,
      resource: endpoint,
    });
  } catch {
    revoked = true;
  }
  assert.ok(revoked, "Revoked refresh token was accepted");
  console.log(
    JSON.stringify(
      {
        stage: "verified",
        endpoint: endpoint.toString(),
        server: client.getServerVersion(),
        toolNames,
        product: context.product,
        usageTotals: usage.totals,
        usageProjectCount: usage.projectCount,
        examinedProjects,
        runEvidence,
        refreshVerified: true,
        revocationVerified: true,
        missingResourceRejected: true,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      stage: "failed",
      errorName: error?.name ?? "Error",
      message:
        error instanceof assert.AssertionError
          ? error.message
          : "MCP verification failed; no credentials or raw response printed",
    }),
  );
  process.exitCode = 1;
} finally {
  try {
    await revoke();
  } catch {
    console.error("Cleanup: refresh revocation could not be confirmed");
    process.exitCode = 1;
  }
  await client.close();
  callback.close();
  clearTimeout(timer);
}
