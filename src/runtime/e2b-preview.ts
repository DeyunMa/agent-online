import type {
  SandboxPreviewAvailability,
  SandboxPreviewRequest,
  SandboxPreviewStartInput,
} from "./contract";
import { SandboxPreviewUnavailableError } from "./contract";
import { toShellCommand } from "./e2b-shell";
import type { E2BSandbox } from "./e2b-types";

export const e2bPreviewConfigPath = "/tmp/agent-online-vite-preview.config.mjs";
export const e2bPreviewExecutable = "/opt/agent-online/preview/node_modules/.bin/vite";
export const e2bPreviewConfig = `export default {
  appType: "spa",
  clearScreen: false,
  root: "/workspace",
  server: {
    cors: false,
    hmr: false,
    ws: false,
  },
};
`;

const previewFetchTimeoutMs = 15_000;
const previewPort = 3000;
const previewWorkingDirectory = "/workspace";
const previewPackageJsonLimitBytes = 64 * 1024;

export function assertE2BPreviewStartInput(input: SandboxPreviewStartInput) {
  if (
    input.port !== previewPort ||
    input.preset !== "vite-v1" ||
    !isSafePreviewBasePath(input.contentBasePath)
  ) {
    throw new Error("E2B Preview preset is invalid");
  }
  requirePositiveTimeout(input.processTimeoutMs);
  requirePositiveTimeout(input.startupTimeoutMs);
}

export function createE2BVitePreviewCommand(contentBasePath: string) {
  return {
    args: [
      "--host",
      "0.0.0.0",
      "--port",
      String(previewPort),
      "--strictPort",
      "--config",
      e2bPreviewConfigPath,
      "--base",
      contentBasePath,
    ],
    command: e2bPreviewExecutable,
    cwd: previewWorkingDirectory,
    env: {
      BROWSER: "none",
      HOST: "0.0.0.0",
      PORT: String(previewPort),
    },
  };
}

export async function inspectE2BPreview(sandbox: E2BSandbox): Promise<SandboxPreviewAvailability> {
  const entries = await sandbox.files.list(previewWorkingDirectory);
  const entry = entries.find((candidate) => candidate.name === "index.html");
  if (entry?.type !== "file") {
    return { kind: "entry_missing" };
  }

  const packageJson = entries.find(
    (candidate) => candidate.name === "package.json" && candidate.type === "file",
  );
  const nodeModules = entries.find(
    (candidate) => candidate.name === "node_modules" && candidate.type === "dir",
  );
  if (
    packageJson &&
    packageJson.size <= previewPackageJsonLimitBytes &&
    !nodeModules &&
    (await packageJsonDeclaresDependencies(sandbox))
  ) {
    return { kind: "dependencies_missing" };
  }

  return { kind: "ready" };
}

export function requireE2BTrafficAccessToken(sandbox: E2BSandbox) {
  if (!sandbox.trafficAccessToken) {
    throw new Error("E2B Preview traffic access token is unavailable");
  }
  return sandbox.trafficAccessToken;
}

export function toE2BPreviewStartError(stage: string, error: unknown) {
  const sourceName = error instanceof Error ? error.name : "UnknownError";
  const result = new Error("E2B Preview start failed", {
    cause: error,
  });
  result.name = `E2BPreviewStartError.${stage}.${sourceName}`;
  return result;
}

export async function writeE2BPreviewConfigWithCommand(sandbox: E2BSandbox) {
  const script =
    `umask 077 && printf %s ${btoa(e2bPreviewConfig)}` + ` | base64 -d > ${e2bPreviewConfigPath}`;
  const process = await sandbox.commands.run(
    toShellCommand({
      args: ["-c", script],
      command: "/bin/sh",
    }),
    {
      background: true,
      cwd: "/tmp",
      timeoutMs: 10_000,
    },
  );
  const result = await process.wait();
  if (result.exitCode !== 0) {
    throw new Error("E2B Preview config command failed");
  }
}

export async function waitForE2BPreviewReady(
  sandbox: E2BSandbox,
  processId: number,
  port: number,
  contentBasePath: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  const trafficAccessToken = requireE2BTrafficAccessToken(sandbox);

  while (Date.now() < deadline) {
    const processes = await sandbox.commands.list();
    if (!processes.some((process) => process.pid === processId)) {
      throw new SandboxPreviewUnavailableError(
        "Preview process exited before the port became ready",
      );
    }

    try {
      const response = await fetch(`https://${sandbox.getHost(port)}${contentBasePath}`, {
        headers: {
          "e2b-traffic-access-token": trafficAccessToken,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      });
      await response.body?.cancel();
      if (response.ok) {
        return;
      }
    } catch {
      // Port startup is polled until the bounded deadline.
    }

    await sleep(500);
  }

  throw new SandboxPreviewUnavailableError(
    "Preview port did not become ready before the startup deadline",
  );
}

async function packageJsonDeclaresDependencies(sandbox: E2BSandbox) {
  try {
    const content = await sandbox.files.read("/workspace/package.json", {
      format: "bytes",
    });
    const value: unknown = JSON.parse(new TextDecoder().decode(content));
    if (!isRecord(value)) {
      return false;
    }
    return ["dependencies", "devDependencies", "optionalDependencies"].some((key) => {
      const dependencies = value[key];
      return isRecord(dependencies) && Object.keys(dependencies).length > 0;
    });
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function fetchE2BPreview(
  sandbox: E2BSandbox,
  port: number,
  request: SandboxPreviewRequest,
) {
  assertPreviewRequest(port, request);
  const trafficAccessToken = requireE2BTrafficAccessToken(sandbox);
  const headers = new Headers(request.headers);
  headers.set("e2b-traffic-access-token", trafficAccessToken);

  return fetch(`https://${sandbox.getHost(port)}${request.pathAndQuery}`, {
    headers,
    method: request.method,
    redirect: "manual",
    signal: AbortSignal.timeout(previewFetchTimeoutMs),
  });
}

function isSafePreviewBasePath(value: string) {
  return (
    value.startsWith("/api/projects/") &&
    value.includes("/preview/content/") &&
    value.endsWith("/") &&
    value.length <= 2_048 &&
    !value.includes("\0") &&
    !/[\r\n?#]/.test(value) &&
    !value.split("/").some((segment) => segment === "..")
  );
}

function assertPreviewRequest(port: number, request: SandboxPreviewRequest) {
  if (
    port !== previewPort ||
    (request.method !== "GET" && request.method !== "HEAD") ||
    !request.pathAndQuery.startsWith("/") ||
    request.pathAndQuery.length > 4_096 ||
    request.pathAndQuery.includes("\0") ||
    /[\r\n]/.test(request.pathAndQuery)
  ) {
    throw new Error("E2B Preview request is invalid");
  }
}

function sleep(durationMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function requirePositiveTimeout(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("E2BSandboxRuntime timeouts must be positive safe integers");
  }

  return value;
}
