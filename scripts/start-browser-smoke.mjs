import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";

const statePath = ".wrangler/browser-smoke";
const configPath = "tests/browser/wrangler.jsonc";

await rm(statePath, { force: true, recursive: true });
await runCommand("pnpm", [
  "wrangler",
  "d1",
  "migrations",
  "apply",
  "DB",
  "--local",
  "--persist-to",
  statePath,
  "--config",
  configPath,
]);

const server = spawn("pnpm", ["vite", "--mode", "browser-smoke", "--host", "127.0.0.1"], {
  env: {
    ...process.env,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
    CLOUDFLARE_VITE_FORCE_LOCAL: "true",
  },
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.kill(signal);
  });
}

server.on("error", (error) => {
  console.error("Unable to start browser smoke server", {
    errorName: error.name,
  });
  process.exitCode = 1;
});
server.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        CLOUDFLARE_VITE_FORCE_LOCAL: "true",
      },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}
