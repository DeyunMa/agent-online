import { cimd } from "@better-auth/cimd";

/** Network trust policy, independent of user consent. Add origins only after operator review.
 * Workers Fetch cannot pin DNS addresses. Restrict it to operator-trusted DNS origins
 * instead of accepting attacker-controlled hosts or pretending a DNS precheck is sufficient.
 */
export function isAllowedMetadataUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.origin === "https://chatgpt.com" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
      /^\/oauth\/(?:[a-zA-Z0-9_-]+\/)*client\.json$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export async function fetchTrustedClientMetadata(input: RequestInfo | URL, init?: RequestInit) {
  // workerd supports manual/follow, not Request.redirect="error".
  const request = new Request(input, { ...init, redirect: "manual" });
  if (
    !(isAllowedMetadataUrl(request.url) || request.url === "https://chatgpt.com/oauth/jwks.json") ||
    !["GET", "HEAD"].includes(request.method)
  )
    throw new Error("Unapproved client metadata resource");
  // No cookies or authorization headers may cross the network boundary.
  const headers = new Headers({ Accept: "application/json" });
  for (const key of ["if-none-match", "if-modified-since"]) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  const response = await fetch(request.url, {
    method: request.method,
    headers,
    redirect: "manual",
    signal: request.signal,
  });
  if (response.status >= 300 && response.status < 400 && response.status !== 304) {
    await response.body?.cancel();
    throw new Error("Metadata redirects are forbidden");
  }
  return response;
}

// The resolver also merges in-flight persistence, so never share it across databases.
// Weak keys avoid retaining retired bindings; each isolate has its own fetch budget.
const plugins = new WeakMap<D1Database, Map<string, ReturnType<typeof cimd>>>();

export function getCimdPlugin(database: D1Database, issuer: string) {
  let issuers = plugins.get(database);
  if (!issuers) {
    issuers = new Map();
    plugins.set(database, issuers);
  }
  let plugin = issuers.get(issuer);
  if (!plugin) {
    plugin = createCimdPlugin();
    issuers.set(issuer, plugin);
  }
  return plugin;
}

function createCimdPlugin() {
  return cimd({
    metadataProfile: "mcp-2026-07-28",
    fetchClientMetadataResource: fetchTrustedClientMetadata,
    isMetadataDocumentUrlAllowed: isAllowedMetadataUrl,
    maxCacheEntries: 100,
    metadataFetchPolicy: { maximumConcurrentFetches: 4, maximumFetchesPerMinute: 30 },
  });
}
