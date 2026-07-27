import { readFile } from "node:fs/promises";

const configUrl = new URL("../wrangler.jsonc", import.meta.url);
const config = JSON.parse(await readFile(configUrl, "utf8"));
const preview = config.env?.preview;
const errors = [];

if (!preview) {
  errors.push("wrangler.jsonc must define env.preview");
} else {
  const vars = preview.vars ?? {};
  const database = preview.d1_databases?.find(({ binding }) => binding === "DB");

  if (typeof preview.account_id !== "string" || !/^[a-f0-9]{32}$/u.test(preview.account_id)) {
    errors.push("env.preview account_id must explicitly pin the target Cloudflare account");
  }

  if (!database?.database_id || database.database_id === "00000000-0000-0000-0000-000000000000") {
    errors.push("env.preview DB must use the real preview D1 database_id");
  }

  if (!isDeployableHttpsUrl(vars.BETTER_AUTH_URL)) {
    errors.push("env.preview BETTER_AUTH_URL must be the final HTTPS Worker origin");
  }

  if (
    typeof vars.E2B_TEMPLATE_ID !== "string" ||
    vars.E2B_TEMPLATE_ID.trim() === "" ||
    vars.E2B_TEMPLATE_ID.includes("replace-with")
  ) {
    errors.push("env.preview E2B_TEMPLATE_ID must be an exact E2B template build reference");
  }

  const gooseRuntimeMode = vars.GOOSE_RUNTIME_MODE ?? "disabled";
  if (!["disabled", "spike", "public"].includes(gooseRuntimeMode)) {
    errors.push("env.preview GOOSE_RUNTIME_MODE must be disabled, spike, or public");
  }

  if (gooseRuntimeMode === "public") {
    errors.push("env.preview GOOSE_RUNTIME_MODE=public is not approved by ADR-0004");
  }

  if (
    gooseRuntimeMode !== "disabled" &&
    !vars.E2B_TEMPLATE_ID?.startsWith("agent-online-pi-goose-runtime:")
  ) {
    errors.push("env.preview must use the combined Pi/Goose template when Goose is enabled");
  }

  if (vars.ACCESS_MODE !== "allowlist") {
    errors.push("env.preview ACCESS_MODE must remain allowlist");
  }

  if (vars.RUNTIME_PROVIDER !== "e2b") {
    errors.push("env.preview RUNTIME_PROVIDER must be e2b");
  }

  if (vars.RUNS_ENABLED !== "true" && vars.RUNS_ENABLED !== "false") {
    errors.push("env.preview RUNS_ENABLED must be true or false");
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log("Preview deployment config is ready.");
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
