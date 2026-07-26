import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";

import { CommandExitError, Sandbox, type CommandResult, type CommandStartOpts } from "e2b";
import { describe, expect, it } from "vitest";

import {
  createOpenAiCompatibleModelGateway,
  type ModelGatewayUsage,
} from "../server/model-gateway";

const modelId = "gemini-3.6-flash";
const piPackageVersion = "0.82.0";
const nodeRuntimeVersion = "24.16.0";
const testMarker = "AGENT_ONLINE_E2E_OK";
const isEnabled = process.env.RUN_E2E === "1";

const realE2E = isEnabled ? describe : describe.skip;

realE2E("E2B + Pi + Gemini ModelGateway spike", () => {
  it("keeps GEMINI_API_KEY outside the sandbox and receives a real Pi response with usage", async () => {
    loadLocalTestEnvironment();
    const geminiApiKey = requireEnvironment("GEMINI_API_KEY");
    const e2bApiKey = requireEnvironment("E2B_API_KEY");
    const e2bTemplateId = requireEnvironment("E2B_TEMPLATE_ID");

    const capabilityToken = randomBytes(32).toString("base64url");
    const redactOutput = createOutputRedactor([capabilityToken, e2bApiKey, geminiApiKey]);
    const usage: ModelGatewayUsage[] = [];
    const gateway = createOpenAiCompatibleModelGateway({
      async authorize(request) {
        return request.headers.get("authorization") === `Bearer ${capabilityToken}`
          ? { maxOutputTokens: 128, modelId, projectId: "spike-project", runId: "spike-run" }
          : null;
      },
      geminiApiKey,
      onUsage: (entry) => {
        usage.push(entry);
      },
    });

    const localGateway = await startLocalGateway(gateway);
    let tunnel: QuickTunnel | null = null;
    let sandbox: Sandbox | null = null;

    try {
      tunnel = await startQuickTunnel(localGateway.url);
      sandbox = await Sandbox.create(e2bTemplateId, {
        envs: {
          AGENT_ONLINE_GATEWAY_TOKEN: capabilityToken,
          PI_CODING_AGENT_DIR: "/tmp/agent-online-pi",
        },
        metadata: { app: "agent-online", purpose: "e2b-pi-gemini-spike" },
        timeoutMs: 180_000,
      });

      const templateProbe = await runSandboxCommand(sandbox, "sandbox template and isolation probe",
        'test -z "${E2B_API_KEY:-}" && test -z "${GEMINI_API_KEY:-}" && test -n "${AGENT_ONLINE_GATEWAY_TOKEN:-}" && test -w /workspace && node --version && pi --version',
        { timeoutMs: 30_000 }, redactOutput,
      );
      expect(templateProbe.exitCode).toBe(0);
      const [nodeVersion, piVersion] = templateProbe.stdout.trim().split(/\r?\n/);
      expect(nodeVersion).toBe(`v${nodeRuntimeVersion}`);
      expect(piVersion).toContain(piPackageVersion);

      await runSandboxCommand(
        sandbox,
        "sandbox workspace preparation",
        "mkdir -p /tmp/agent-online-pi",
        { timeoutMs: 30_000 },
        redactOutput,
      );
      await sandbox.files.write("/tmp/agent-online-pi/models.json", JSON.stringify({
        providers: {
          "agent-online-spike": {
            api: "openai-completions",
            apiKey: "$AGENT_ONLINE_GATEWAY_TOKEN",
            authHeader: true,
            baseUrl: `${tunnel.publicUrl}/v1`,
            compat: {
              maxTokensField: "max_tokens",
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
              supportsStore: false,
              supportsUsageInStreaming: true,
            },
            models: [{
              contextWindow: 128_000,
              id: modelId,
              input: ["text"],
              maxTokens: 128,
              name: "Agent Online Gemini spike",
              reasoning: false,
            }],
          },
        },
      }));

      const availableModels = await runSandboxCommand(
        sandbox,
        "Pi custom model discovery",
        "pi --no-extensions --no-skills --no-context-files --list-models",
        { cwd: "/workspace", timeoutMs: 30_000 },
        redactOutput,
      );
      expect(availableModels.stdout).toContain("agent-online-spike");
      expect(availableModels.stdout).toContain(modelId);

      const execution = await runSandboxCommand(
        sandbox,
        "Pi model request",
        "pi --no-session --no-extensions --no-skills --no-context-files --provider agent-online-spike --model gemini-3.6-flash --print 'Create /workspace/agent-online-e2e.txt containing exactly AGENT_ONLINE_E2E_OK, verify the file, then reply with exactly AGENT_ONLINE_E2E_OK.'",
        { cwd: "/workspace", timeoutMs: 120_000 },
        redactOutput,
      );

      expect(execution.exitCode).toBe(0);
      expect(execution.stdout).toContain(testMarker);
      const fileProbe = await runSandboxCommand(
        sandbox,
        "Pi tool result verification",
        `test "$(cat /workspace/agent-online-e2e.txt)" = "${testMarker}"`,
        { cwd: "/workspace", timeoutMs: 30_000 },
        redactOutput,
      );
      expect(fileProbe.exitCode).toBe(0);
      expect(usage.length).toBeGreaterThan(0);
      expect(usage.reduce((total, entry) => total + entry.modelRequestCount, 0)).toBeGreaterThan(0);
      expect(usage.reduce((total, entry) => total + entry.totalTokens, 0)).toBeGreaterThan(0);
    } finally {
      if (sandbox) {
        await sandbox.kill();
      }
      if (tunnel) {
        await tunnel.close();
      }
      await localGateway.close();
    }
  }, 180_000);
});

type LocalGateway = {
  close(): Promise<void>;
  url: string;
};

type QuickTunnel = {
  close(): Promise<void>;
  publicUrl: string;
};

async function startLocalGateway(handler: (request: Request) => Promise<Response>): Promise<LocalGateway> {
  const server = createServer(async (request, response) => {
    try {
      const gatewayRequest = await toFetchRequest(request);
      const gatewayResponse = await handler(gatewayRequest);
      await writeFetchResponse(response, gatewayResponse);
    } catch (_error) {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "gateway_transport_error" }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address() as AddressInfo;
  return {
    async close() {
      await closeServer(server);
    },
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function startQuickTunnel(localUrl: string): Promise<QuickTunnel> {
  const executable = process.env.CLOUDFLARED_BIN ?? "cloudflared";
  const tunnelProcess = spawn(executable, ["tunnel", "--no-autoupdate", "--url", localUrl], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const publicUrl = await waitForQuickTunnelUrl(tunnelProcess);

  return {
    async close() {
      await stopProcess(tunnelProcess);
    },
    publicUrl,
  };
}

function waitForQuickTunnelUrl(process: ChildProcess) {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("Timed out waiting for Cloudflare Quick Tunnel.")), 30_000);
    const inspect = (chunk: Buffer) => {
      const match = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match) {
        finish(undefined, match[0]);
      }
    };
    const fail = () => finish(new Error("Cloudflare Quick Tunnel could not start. Set CLOUDFLARED_BIN or install cloudflared."));
    const finish = (error?: Error, publicUrl?: string) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      process.stdout?.off("data", inspect);
      process.stderr?.off("data", inspect);
      process.off("error", fail);
      process.off("exit", fail);

      if (error) {
        void stopProcess(process);
        reject(error);
      } else {
        resolve(publicUrl!);
      }
    };

    process.stdout?.on("data", inspect);
    process.stderr?.on("data", inspect);
    process.once("error", fail);
    process.once("exit", fail);
  });
}

async function toFetchRequest(request: IncomingMessage) {
  const body = await readRequestBody(request);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) {
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
  }

  return new Request(`http://127.0.0.1${request.url ?? "/"}`, {
    body: body.length > 0 ? (body as unknown as BodyInit) : undefined,
    headers,
    method: request.method ?? "GET",
  });
}

async function writeFetchResponse(response: ServerResponse, gatewayResponse: Response) {
  response.statusCode = gatewayResponse.status;
  for (const [name, value] of gatewayResponse.headers) {
    response.setHeader(name, value);
  }

  if (!gatewayResponse.body) {
    response.end();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const stream = Readable.fromWeb(gatewayResponse.body as never);
    stream.once("error", reject);
    response.once("finish", resolve);
    stream.pipe(response);
  });
}

async function readRequestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

async function closeServer(server: Server) {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function stopProcess(process: ChildProcess) {
  if (process.exitCode !== null || process.killed) {
    return;
  }

  process.kill("SIGTERM");
  const exited = await Promise.race([
    once(process, "exit").then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);

  if (!exited && process.exitCode === null) {
    process.kill("SIGKILL");
    await once(process, "exit");
  }
}

function loadLocalTestEnvironment() {
  if (existsSync(".dev.vars")) {
    process.loadEnvFile(".dev.vars");
  }
}

function requireEnvironment(name: "E2B_API_KEY" | "E2B_TEMPLATE_ID" | "GEMINI_API_KEY") {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set before RUN_E2E=1 is used.`);
  }

  return value;
}

type ForegroundCommandOptions = Omit<CommandStartOpts, "background"> & { background?: false };

async function runSandboxCommand(
  sandbox: Sandbox,
  label: string,
  command: string,
  options: ForegroundCommandOptions,
  redactOutput: (value: string) => string,
): Promise<CommandResult> {
  try {
    return await sandbox.commands.run(command, options);
  } catch (error) {
    if (error instanceof CommandExitError) {
      const output = redactOutput(`${error.stderr}\n${error.stdout}`).trim();
      throw new Error(`${label} failed with exit code ${error.exitCode}: ${output.slice(0, 2_000) || "no output"}`);
    }

    throw error;
  }
}

function createOutputRedactor(values: string[]) {
  return (value: string) => values.reduce(
    (redacted, secret) => redacted.split(secret).join("[redacted]"),
    value.replace(/AIza[\w-]+/g, "[redacted]"),
  );
}
