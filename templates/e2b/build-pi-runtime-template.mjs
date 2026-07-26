import { existsSync } from "node:fs";

import { Template, defaultBuildLogger } from "e2b";

import { createPiRuntimeTemplate, piRuntimeTemplate } from "./pi-runtime.template.mjs";

if (existsSync(".dev.vars")) {
  process.loadEnvFile(".dev.vars");
}

if (!process.env.E2B_API_KEY) {
  throw new Error("E2B_API_KEY must be set before building the E2B Pi runtime template.");
}

const build = await Template.build(
  createPiRuntimeTemplate(),
  `${piRuntimeTemplate.name}:${piRuntimeTemplate.tag}`,
  {
    cpuCount: 2,
    memoryMB: 1024,
    onBuildLogs: defaultBuildLogger(),
  },
);

console.log(`E2B_TEMPLATE_ID=${piRuntimeTemplate.name}:${build.buildId}`);
