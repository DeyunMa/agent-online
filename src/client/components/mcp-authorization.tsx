import { useEffect, useState } from "react";
import { authClient } from "../auth";
import { Button } from "./ui/button";

export function McpAuthorization() {
  const [clientName, setClientName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const query = new URLSearchParams(window.location.search);
  const clientId = query.get("client_id");
  const scopes = (query.get("scope") ?? "").split(" ").filter(Boolean);
  const valid = Boolean(
    clientId &&
      query.get("sig") &&
      scopes.includes("insights:read") &&
      scopes.every((scope) => ["insights:read", "offline_access"].includes(scope)),
  );

  useEffect(() => {
    if (!clientId) return;
    let active = true;
    void authClient.oauth2
      .publicClient({ query: { client_id: clientId } })
      .then((result) => {
        if (!active) return;
        if (result.error || !result.data)
          setError("This connection request is unavailable. Start again from your MCP client.");
        else setClientName(result.data.client_name || "MCP client");
      })
      .catch(() => {
        if (active) setError("Could not load the connection request.");
      });
    return () => {
      active = false;
    };
  }, [clientId]);

  async function consent(accept: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.oauth2.consent({ accept });
      if (result.error || !result.data?.url) {
        setError("Authorization failed or expired. Start again from your MCP client.");
        return;
      }
      // Redirect is returned by the OAuth provider after validating the signed request and client registration.
      window.location.assign(result.data.url);
    } catch {
      setError("Authorization is temporarily unavailable.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="mcp-title">
        <h1 id="mcp-title">Connect to Agent Online</h1>
        <p>{clientName ?? "Loading client…"} requests access to your account.</p>
        <p className="break-all text-sm">Client ID: {clientId}</p>
        <p>
          Allow it to read your Project titles and status, Run summaries, failure categories, and
          recorded usage, including usage of deleted Projects.
        </p>
        <p>Your messages, files, credentials, and sandbox controls are excluded.</p>
        {scopes.includes("offline_access") ? (
          <p>
            Allow this connection to renew access in the background. Manage it in Connected apps,
            where current revocation limitations are explained.
          </p>
        ) : null}
        <p>
          Only approve a client you intended to connect. Its display name is supplied by the client.
        </p>
        {!valid ? (
          <p role="alert">Invalid connection request. Start again from your MCP client.</p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <div className="flex gap-3 mt-5">
          <Button
            disabled={busy || !valid || !clientName}
            onClick={() => void consent(false)}
            variant="outline"
          >
            Deny
          </Button>
          <Button disabled={busy || !valid || !clientName} onClick={() => void consent(true)}>
            Allow read access
          </Button>
        </div>
      </section>
    </main>
  );
}
