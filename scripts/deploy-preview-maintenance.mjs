/**
 * Deploy a brief API maintenance window using an already built, schema-compatible release.
 * Usage: node scripts/deploy-preview-maintenance.mjs --build-root /absolute/checkout --confirm
 * Prerequisites: authenticated Wrangler; `pnpm build:preview` in that checkout; clean preflight.
 * Target: pinned private Preview only. No database writes, secret changes, or resource creation.
 * Effect: old Workflow exports remain; API except health/capabilities returns 503 + Retry-After.
 * Verify health=200, capabilities disabled, /api/projects=503; rerun remote preflight before SQL.
 * Recovery before migration: redeploy the compatible release. After migration: deploy matching
 * current code with `pnpm deploy:preview`; never roll database triggers back blindly.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import "./validate-preview-account.mjs";

if (process.exitCode) process.exit(process.exitCode);
const args = process.argv.slice(2);
if (
  args.length !== 3 ||
  args[0] !== "--build-root" ||
  !path.isAbsolute(args[1]) ||
  args[2] !== "--confirm"
) {
  throw new Error("Expected --build-root /absolute/checkout --confirm");
}
const buildRoot = args[1];
const directory = path.join(buildRoot, "dist/agent_online");
const config = JSON.parse(await readFile(path.join(directory, "wrangler.json"), "utf8"));
const source = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
if (
  config.account_id !== source.env.preview.account_id ||
  config.name !== "agent-online-preview" ||
  config.d1_databases?.[0]?.database_id !== source.env.preview.d1_databases[0].database_id ||
  config.vars?.ACCESS_MODE !== "allowlist" ||
  config.main !== "index.js"
) {
  throw new Error("Built configuration does not match the pinned Preview target");
}
await writeFile(
  path.join(directory, "maintenance-entry.mjs"),
  `
import application from "./index.js";
export * from "./index.js";
export default {
  async fetch(request, env, ctx) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/health") return application.fetch(request, env, ctx);
    if (pathname === "/api/capabilities") {
      const response = await application.fetch(request, env, ctx);
      return Response.json({ ...await response.json(), runCreationEnabled: false,
        terminalEnabled: false, previewEnabled: false, fileUploadEnabled: false },
        { headers: { "cache-control": "no-store" } });
    }
    return Response.json({ error: { code: "service.unavailable", retryable: true },
      requestId: crypto.randomUUID() },
      { status: 503, headers: { "retry-after": "120", "cache-control": "no-store" } });
  }
};
`,
);
config.main = "maintenance-entry.mjs";
config.vars.RUNS_ENABLED = "false";
const configPath = path.join(directory, "maintenance.wrangler.json");
await writeFile(configPath, JSON.stringify(config, null, 2));
const result = spawnSync("pnpm", ["exec", "wrangler", "deploy", "--config", configPath], {
  cwd: buildRoot,
  env: process.env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
