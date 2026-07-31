import { readFile } from "node:fs/promises";

const configUrl = new URL("../wrangler.jsonc", import.meta.url);
const config = JSON.parse(await readFile(configUrl, "utf8"));
const vars = config.vars ?? {};
const database = config.d1_databases?.find(({ binding }) => binding === "DB");
const workflow = config.workflows?.find(({ binding }) => binding === "AGENT_RUN_WORKFLOW");
const errors = [];

if (!database?.database_id || database.database_id === "00000000-0000-0000-0000-000000000000") {
  errors.push("top-level DB must use a real production D1 database_id");
}

if (!isDeployableHttpsUrl(vars.BETTER_AUTH_URL)) {
  errors.push("top-level BETTER_AUTH_URL must be the final HTTPS production origin");
}

if (vars.ACCESS_MODE !== "allowlist") {
  errors.push("top-level ACCESS_MODE must remain allowlist until public access is approved");
}

if (vars.RUNTIME_PROVIDER !== "e2b") {
  errors.push("top-level RUNTIME_PROVIDER must be e2b");
}

if (
  typeof vars.E2B_TEMPLATE_ID !== "string" ||
  vars.E2B_TEMPLATE_ID.trim() === "" ||
  vars.E2B_TEMPLATE_ID.includes("replace-with")
) {
  errors.push("top-level E2B_TEMPLATE_ID must be an exact E2B template build reference");
}

if (vars.RUNS_ENABLED !== "true" && vars.RUNS_ENABLED !== "false") {
  errors.push("top-level RUNS_ENABLED must be true or false");
}

if (
  vars.GOOSE_RUNTIME_MODE !== undefined &&
  !["disabled", "spike", "public"].includes(vars.GOOSE_RUNTIME_MODE)
) {
  errors.push("top-level GOOSE_RUNTIME_MODE must be disabled, spike, or public");
}

if (
  vars.GOOSE_RUNTIME_MODE !== undefined &&
  vars.GOOSE_RUNTIME_MODE !== "disabled" &&
  !vars.E2B_TEMPLATE_ID?.startsWith("agent-online-pi-goose-runtime:")
) {
  errors.push("top-level deployment must use the combined Pi/Goose template when Goose is enabled");
}

if (!workflow?.name || workflow.name === "agent-online-preview-run") {
  errors.push("top-level AGENT_RUN_WORKFLOW must use a dedicated production Workflow");
}

if (errors.length > 0) {
  console.error("Production deployment is not configured:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  console.error("Use `pnpm deploy:preview` for the configured private Preview.");
  process.exitCode = 1;
} else {
  console.log("Production deployment config is ready.");
}

function isDeployableHttpsUrl(value) {
  if (typeof value !== "string" || value.includes("replace-me")) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}
