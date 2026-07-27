import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode !== "--local" && mode !== "--remote") {
  console.error("Pass exactly one target: --local or --remote.");
  process.exit(1);
}

if (mode === "--remote") {
  await import("./validate-preview-account.mjs");
  if (process.exitCode) {
    process.exit(process.exitCode);
  }
}

const sqlPath = fileURLToPath(new URL("./sql/preview-release-preflight.sql", import.meta.url));
const sql = readFileSync(sqlPath, "utf8");
const result = spawnSync(
  "pnpm",
  ["exec", "wrangler", "d1", "execute", "DB", mode, "--env", "preview", "--command", sql, "--json"],
  {
    encoding: "utf8",
    env: process.env,
  },
);

if (result.stderr) {
  process.stderr.write(result.stderr);
}

if (result.error) {
  console.error(`Could not start Wrangler: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  process.exit(result.status ?? 1);
}

let payload;
const stdoutLines = result.stdout.split(/\r?\n/);
for (const [index, line] of stdoutLines.entries()) {
  if (!line.trimStart().startsWith("[") && !line.trimStart().startsWith("{")) {
    continue;
  }

  try {
    payload = JSON.parse(stdoutLines.slice(index).join("\n"));
    break;
  } catch {
    // Wrangler may print progress lines before its final JSON payload.
  }
}

if (payload === undefined) {
  console.error("Wrangler returned an unreadable D1 preflight response.");
  process.exit(1);
}

const executions = Array.isArray(payload) ? payload : [payload];
if (executions.some((execution) => execution?.success !== true)) {
  console.error("D1 preflight reported an unsuccessful statement.");
  process.exit(1);
}

const rows = executions.flatMap((execution) =>
  Array.isArray(execution?.results) ? execution.results : [],
);

if (rows.length === 0) {
  console.error("D1 preflight returned no checks.");
  process.exit(1);
}

const invalidRows = rows.filter(
  (row) =>
    typeof row?.check_name !== "string" ||
    !Number.isSafeInteger(Number(row?.issue_count)) ||
    Number(row?.issue_count) < 0,
);
if (invalidRows.length > 0) {
  console.error("D1 preflight returned an invalid check result.");
  process.exit(1);
}

const expectedChecks = new Set([
  "active_agent_runs",
  "agent_run_input_message_mismatches",
  "agent_run_ownership_mismatches",
  "foreign_key_violations",
  "message_agent_link_mismatches",
  "preview_lease_mismatches",
  "preview_sessions",
  "terminal_lease_mismatches",
  "terminal_sessions",
]);
const actualChecks = new Set(rows.map((row) => row.check_name));
if (
  rows.length !== expectedChecks.size ||
  actualChecks.size !== expectedChecks.size ||
  [...expectedChecks].some((check) => !actualChecks.has(check))
) {
  console.error("D1 preflight did not return the complete expected check set.");
  process.exit(1);
}

const failures = rows.filter((row) => Number(row.issue_count) !== 0);
if (failures.length > 0) {
  console.error("Preview release preflight failed:");
  for (const failure of failures) {
    console.error(`- ${failure.check_name}: ${failure.issue_count}`);
  }
  process.exit(1);
}

console.log(`Preview release preflight passed (${rows.length} checks).`);
