import { Hono } from "hono";
import type { AppEnv } from "../env";
import { getAuthenticatedUser } from "../auth-context";
import { renderApiError } from "../http/api-errors";
import type { McpConnectionsResponse } from "../../shared/mcp-connections";

export function createMcpConnectionsApi() {
  const api = new Hono<AppEnv>();
  api.use("/mcp/connections/*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    await next();
  });
  api.get("/mcp/connections", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const user = await getAuthenticatedUser(c.env, c.req.raw.headers);
    if (!user) return renderApiError(c, "auth.unauthorized");
    const cursor = c.req.query("cursor") ?? "";
    if (cursor.length > 128) return c.json({ error: "request.invalid" }, 400);
    const rows =
      await c.env.DB.prepare(`SELECT c.id,c.clientId,c.scopes,COALESCE(o.name,'MCP client') AS name
      FROM oauthConsent c JOIN oauthClient o ON o.clientId=c.clientId
      WHERE c.userId=? AND c.id>? ORDER BY c.id LIMIT 51`)
        .bind(user.id, cursor)
        .all<{ id: string; clientId: string; scopes: string; name: string }>();
    const items = rows.results
      .slice(0, 50)
      .map((row) => ({ ...row, scopes: JSON.parse(row.scopes) as string[] }));
    return c.json<McpConnectionsResponse>({
      items,
      nextCursor: rows.results.length > 50 ? (items.at(-1)?.id ?? null) : null,
    });
  });
  api.post("/mcp/connections/:id/revoke", async (c) => {
    const user = await getAuthenticatedUser(c.env, c.req.raw.headers);
    if (!user) return renderApiError(c, "auth.unauthorized");
    const id = c.req.param("id");
    // One atomic transaction, scoped to the session owner throughout. Do not delete
    // the shared OAuth client or another user's consent/tokens for the same client.
    const client = "SELECT clientId FROM oauthConsent WHERE id=? AND userId=?";
    await c.env.DB.batch([
      c.env.DB.prepare(
        `DELETE FROM oauthAccessToken WHERE userId=? AND clientId IN (${client})`,
      ).bind(user.id, id, user.id),
      c.env.DB.prepare(
        `DELETE FROM oauthRefreshToken WHERE userId=? AND clientId IN (${client})`,
      ).bind(user.id, id, user.id),
      c.env.DB.prepare(`DELETE FROM oauthConsent WHERE userId=? AND clientId IN (${client})`).bind(
        user.id,
        id,
        user.id,
      ),
    ]);
    return c.json({ revoked: true });
  });
  return api;
}
