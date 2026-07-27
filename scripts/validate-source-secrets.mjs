import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { findSensitiveLabels } from "./secret-patterns.mjs";

const execFileAsync = promisify(execFile);
const { stdout } = await execFileAsync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  {
    encoding: "buffer",
    maxBuffer: 16 * 1_024 * 1_024,
  },
);
const trackedPaths = stdout.toString("utf8").split("\0").filter(Boolean);
const findings = [];

for (const path of trackedPaths) {
  if (isForbiddenEnvironmentFile(path)) {
    findings.push({ label: "local environment file", path });
    continue;
  }

  let contents;
  try {
    contents = await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      continue;
    }
    throw error;
  }
  for (const label of findSensitiveLabels(contents)) {
    findings.push({ label, path });
  }
}

if (findings.length > 0) {
  console.error("Repository source contains possible credential material:");
  for (const finding of findings) {
    console.error(`- ${finding.path} (${finding.label})`);
  }
  process.exitCode = 1;
} else {
  console.log("Repository source secret scan passed.");
}

function isForbiddenEnvironmentFile(path) {
  const name = path.split("/").at(-1) ?? path;
  return (
    (name.startsWith(".dev.vars") && name !== ".dev.vars.example") ||
    (name.startsWith(".env") && name !== ".env.example")
  );
}
