import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { findSensitiveLabels } from "./secret-patterns.mjs";

const outputUrl = new URL("../dist/", import.meta.url);
const outputPath = fileURLToPath(outputUrl);
const forbiddenPaths = [];
const sensitiveMatches = [];

try {
  await scanDirectory(outputPath);
} catch (error) {
  if (error?.code === "ENOENT") {
    console.error("Build output is missing. Run a build before validation.");
    process.exitCode = 1;
  } else {
    throw error;
  }
}

if (forbiddenPaths.length > 0) {
  console.error("Build output contains forbidden local environment files:");
  for (const path of forbiddenPaths) {
    console.error(`- ${path}`);
  }
  process.exitCode = 1;
}

if (sensitiveMatches.length > 0) {
  console.error("Build output contains possible credential material:");
  for (const match of sensitiveMatches) {
    console.error(`- ${match.path} (${match.label})`);
  }
  process.exitCode = 1;
}

if (process.exitCode !== 1) {
  console.log("Build artifact secret scan passed.");
}

async function scanDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);

    if (isForbiddenName(entry.name)) {
      forbiddenPaths.push(relative(outputPath, entryPath));
      continue;
    }

    if (entry.isDirectory()) {
      await scanDirectory(entryPath);
      continue;
    }

    if (entry.isFile()) {
      await scanFile(entryPath);
    }
  }
}

async function scanFile(path) {
  const contents = await readFile(path);
  for (const label of findSensitiveLabels(contents)) {
    sensitiveMatches.push({
      label,
      path: relative(outputPath, path),
    });
  }
}

function isForbiddenName(name) {
  return name.startsWith(".dev.vars") || name.startsWith(".env");
}
