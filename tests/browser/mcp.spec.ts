import { createHash, randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { registerAndCreateProject } from "./browser-fixture";

test("OAuth login resumes into explicit consent and exchanges PKCE for read-only MCP access", async ({
  page,
  request,
}) => {
  const { projectName } = await registerAndCreateProject(page, "mcp-browser");
  const signout = await page.request.post("/api/auth/sign-out", {
    data: {},
    headers: { Origin: "http://127.0.0.1:4173" },
  });
  expect(signout.ok()).toBe(true);
  const registration = await request.post("/api/auth/oauth2/register", {
    data: {
      client_name: "Browser MCP verification",
      redirect_uris: ["http://127.0.0.1:4173/mcp/callback"],
      token_endpoint_auth_method: "none",
      application_type: "native",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "insights:read offline_access",
    },
  });
  expect(registration.ok()).toBe(true);
  const { client_id } = await registration.json();
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    client_id,
    response_type: "code",
    redirect_uri: "http://127.0.0.1:4173/mcp/callback",
    scope: "insights:read offline_access",
    resource: "http://127.0.0.1:4173/mcp",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "browser-mcp",
  });
  await page.goto(`/api/auth/oauth2/authorize?${query}`);
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await page.getByLabel("Email").fill(`${projectName}@example.com`);
  await page.getByLabel("Password").fill("browser-smoke-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connect to Agent Online" })).toBeVisible();
  await expect(
    page.getByText("Browser MCP verification requests access to your account."),
  ).toBeVisible();
  await expect(
    page.getByText("Your messages, files, credentials, and sandbox controls are excluded."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Allow read access" }).click();
  await page.waitForURL((url) => url.pathname === "/mcp/callback" && url.searchParams.has("code"));
  const callback = new URL(page.url());
  expect(callback.searchParams.get("state")).toBe("browser-mcp");
  const token = await request.post("/api/auth/oauth2/token", {
    form: {
      client_id,
      grant_type: "authorization_code",
      redirect_uri: "http://127.0.0.1:4173/mcp/callback",
      code: callback.searchParams.get("code") ?? "",
      code_verifier: verifier,
      resource: "http://127.0.0.1:4173/mcp",
    },
  });
  expect(token.ok()).toBe(true);
  const { access_token, refresh_token } = await token.json();
  const initialized = await request.post("/mcp", {
    headers: {
      Authorization: `Bearer ${access_token}`,
      Accept: "application/json, text/event-stream",
    },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "browser-test", version: "1" },
      },
    },
  });
  expect(initialized.ok()).toBe(true);
  expect((await initialized.json()).result.serverInfo.name).toBe("agent-online-insights");
  await page.goto("/settings/connections");
  await expect(page.getByRole("heading", { name: "Connected apps" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Browser MCP verification" })).toBeVisible();
  await page.getByRole("button", { name: "Revoke access" }).click();
  await page.getByRole("button", { name: "Confirm revoke" }).click();
  await expect(page.getByText("No connected apps.")).toBeVisible();
  const refreshed = await request.post("/api/auth/oauth2/token", {
    form: {
      client_id,
      grant_type: "refresh_token",
      refresh_token,
      resource: "http://127.0.0.1:4173/mcp",
    },
  });
  expect(refreshed.status()).toBe(400);
});
