import { existsSync } from "node:fs";

import { Template, defaultBuildLogger } from "e2b";

import {
  createPiGooseRuntimeTemplate,
  piGooseRuntimeTemplate,
} from "./pi-goose-runtime.template.mjs";

if (existsSync(".dev.vars")) {
  process.loadEnvFile(".dev.vars");
}

if (!process.env.E2B_API_KEY) {
  throw new Error("E2B_API_KEY must be set before building the E2B Pi + Goose runtime template.");
}

const templateAlias = `${piGooseRuntimeTemplate.name}:${piGooseRuntimeTemplate.tag}`;

console.log(`Building E2B template ${templateAlias}`);
console.log(
  [
    `Runtime versions: Node ${piGooseRuntimeTemplate.nodeVersion}`,
    `Pi ${piGooseRuntimeTemplate.piVersion}`,
    `Goose ${piGooseRuntimeTemplate.gooseVersion}`,
    `pnpm ${piGooseRuntimeTemplate.pnpmVersion}`,
    `Preview Vite ${piGooseRuntimeTemplate.previewViteVersion}`,
  ].join(", "),
);

const build = await Template.build(createPiGooseRuntimeTemplate(), templateAlias, {
  cpuCount: 2,
  memoryMB: 1024,
  onBuildLogs: defaultBuildLogger(),
});

console.log(`E2B_TEMPLATE_ALIAS=${templateAlias}`);
console.log(`E2B_TEMPLATE_ID=${piGooseRuntimeTemplate.name}:${build.buildId}`);
