import { readdir } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const outputUrl = new URL("../dist/", import.meta.url);
const outputPath = fileURLToPath(outputUrl);
const forbiddenPaths = [];

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
} else if (process.exitCode !== 1) {
  console.log("Build artifact secret-file check passed.");
}

async function scanDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = `${directory}/${entry.name}`;

    if (isForbiddenName(entry.name)) {
      forbiddenPaths.push(relative(outputPath, entryPath));
      continue;
    }

    if (entry.isDirectory()) {
      await scanDirectory(entryPath);
    }
  }
}

function isForbiddenName(name) {
  return name.startsWith(".dev.vars") || name.startsWith(".env");
}
