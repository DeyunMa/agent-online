import { readFile } from "node:fs/promises";

const configUrl = new URL("../wrangler.jsonc", import.meta.url);
const config = JSON.parse(await readFile(configUrl, "utf8"));
const vars = config.vars ?? {};
const templateId = process.env.E2B_TEMPLATE_ID;
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
  typeof templateId !== "string" ||
  !/^agent-online-pi-runtime:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(templateId)
) {
  errors.push(
    "Set E2B_TEMPLATE_ID in the deployment environment to an exact Pi-only build reference",
  );
}

if (vars.RUNS_ENABLED !== "true" && vars.RUNS_ENABLED !== "false") {
  errors.push("top-level RUNS_ENABLED must be true or false");
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
