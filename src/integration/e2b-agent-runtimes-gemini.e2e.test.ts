import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";

import { CommandExitError, Sandbox, type CommandResult, type CommandStartOpts } from "e2b";
import { describe, expect, it } from "vitest";

import { gooseRuntime } from "../agent/goose-runtime";
import { piRuntime } from "../agent/pi-runtime";
import type { AgentEvent, AgentExecutionContext, AgentRunInput } from "../agent/contract";
import type { RuntimeHandle } from "../runtime/contract";
import { E2BSandboxRuntime } from "../runtime/e2b-runtime";
import {
  createOpenAiCompatibleModelGateway,
  type ModelGatewayUsage,
} from "../server/model-gateway";
import { createRunCapabilityCodec } from "../server/run-capability";

const modelId = "gemini-3.6-flash";
const goosePackageVersion = "1.44.0";
const piPackageVersion = "0.82.0";
const nodeRuntimeVersion = "24.16.0";
const piCreatedMarker = "PI_CREATED";
const gooseUpdatedMarker = "GOOSE_UPDATED";
const piVerifiedMarker = "PI_VERIFIED";
const gooseCancellationMarkerPath = "/workspace/agent-online-goose-cancel-started";
const isEnabled = process.env.RUN_E2E === "1";

const realE2E = isEnabled ? describe : describe.skip;

realE2E("E2B + Pi/Goose AgentRuntime + Gemini ModelGateway", () => {
  it("switches Pi -> Goose -> Pi in one sandbox without exposing the Gemini key", async () => {
    loadLocalTestEnvironment();
    const geminiApiKey = requireEnvironment("GEMINI_API_KEY");
    const e2bApiKey = requireEnvironment("E2B_API_KEY");
    const e2bTemplateId = requireEnvironment("E2B_TEMPLATE_ID");

    const capabilityCodec = createRunCapabilityCodec({
      secret: randomBytes(32).toString("base64url"),
    });
    const capabilityTokens = new Map<string, string>();
    const secretsToRedact = [e2bApiKey, geminiApiKey];
    const redactOutput = createOutputRedactor(secretsToRedact);
    const usage: Array<ModelGatewayUsage & { runId: string }> = [];
    const gateway = createOpenAiCompatibleModelGateway({
      async authorize(request) {
        const authorization = request.headers.get("authorization");
        if (!authorization?.startsWith("Bearer ")) {
          return null;
        }
        const claims = await capabilityCodec.verify(authorization.slice("Bearer ".length));
        return claims
          ? {
              maxOutputTokens: claims.maxOutputTokens,
              modelId: claims.modelId,
              projectId: claims.projectId,
              runId: claims.runId,
            }
          : null;
      },
      geminiApiKey,
      onUsage: (entry, capability) => {
        usage.push({ ...entry, runId: capability.runId });
      },
    });

    const localGateway = await startLocalGateway(gateway);
    let tunnel: QuickTunnel | null = null;
    let runtime: E2BSandboxRuntime | null = null;
    let runtimeHandle: RuntimeHandle | null = null;
    let sandbox: Sandbox | null = null;

    try {
      tunnel = await startQuickTunnel(localGateway.url);
      runtime = new E2BSandboxRuntime({
        apiKey: e2bApiKey,
        processTimeoutMs: 180_000,
        sandboxTimeoutMs: 300_000,
        templateId: e2bTemplateId,
      });
      runtimeHandle = await runtime.ensureLease({
        projectId: "spike-project",
        providerRef: null,
        sandboxLeaseId: "spike-lease",
      });
      sandbox = await Sandbox.connect(runtimeHandle.id, { apiKey: e2bApiKey });

      const templateProbe = await runSandboxCommand(
        sandbox,
        "sandbox template and isolation probe",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: The remote shell expands these variables.
        'test -z "${E2B_API_KEY:-}" && test -z "${GEMINI_API_KEY:-}" && test -z "${AGENT_ONLINE_GATEWAY_TOKEN:-}" && test -w /workspace && test "$(stat -c %U /workspace)" = "$(id -un)" && git init -q /workspace && git -C /workspace status --porcelain && rm -rf /workspace/.git && node --version && pi --version && goose --version',
        { timeoutMs: 30_000 },
        redactOutput,
      );
      expect(templateProbe.exitCode).toBe(0);
      const [nodeVersion, piVersion, gooseVersion] = templateProbe.stdout.trim().split(/\r?\n/);
      expect(nodeVersion).toBe(`v${nodeRuntimeVersion}`);
      expect(piVersion).toContain(piPackageVersion);
      expect(gooseVersion).toContain(goosePackageVersion);

      const context = createAgentExecutionContext(runtime, runtimeHandle);
      const piCreate = await piRuntime.start(
        context,
        createAgentRunInput(
          "pi-create",
          `Create /workspace/agent-online-e2e.txt with first and only line ${piCreatedMarker}. Verify it, then reply with exactly ${piCreatedMarker}.`,
          await issueModelAccess(
            capabilityCodec,
            capabilityTokens,
            secretsToRedact,
            `${tunnel.publicUrl}/v1`,
            "pi-create",
          ),
        ),
      );
      const piCreateEvents = await collectAgentEvents(piCreate.events());
      expectSuccessfulCompletion(piCreateEvents, piCreatedMarker);

      const gooseUpdate = await gooseRuntime.start(
        context,
        createAgentRunInput(
          "goose-update",
          `Read /workspace/agent-online-e2e.txt and confirm its first line is ${piCreatedMarker}. Append a second line containing exactly ${gooseUpdatedMarker} without changing the first line. Verify the file has exactly those two non-empty lines, then reply with exactly ${gooseUpdatedMarker}.`,
          await issueModelAccess(
            capabilityCodec,
            capabilityTokens,
            secretsToRedact,
            `${tunnel.publicUrl}/v1`,
            "goose-update",
          ),
        ),
      );
      const gooseUpdateEvents = await collectAgentEvents(gooseUpdate.events());
      expectSuccessfulCompletion(gooseUpdateEvents, gooseUpdatedMarker);
      const gooseFileProbe = await runSandboxCommand(
        sandbox,
        "Goose file continuity verification",
        `node -e 'const fs=require("fs");const lines=fs.readFileSync("/workspace/agent-online-e2e.txt","utf8").split(/\\r?\\n/).filter(Boolean);if(JSON.stringify(lines)!==JSON.stringify(["${piCreatedMarker}","${gooseUpdatedMarker}"]))process.exit(1)'`,
        { cwd: "/workspace", timeoutMs: 30_000 },
        redactOutput,
      );
      expect(gooseFileProbe.exitCode).toBe(0);

      const piVerify = await piRuntime.start(
        context,
        createAgentRunInput(
          "pi-verify",
          `Read /workspace/agent-online-e2e.txt. Keep its existing two lines unchanged, append a third line containing exactly ${piVerifiedMarker}, verify all three lines, then reply with exactly ${piVerifiedMarker}.`,
          await issueModelAccess(
            capabilityCodec,
            capabilityTokens,
            secretsToRedact,
            `${tunnel.publicUrl}/v1`,
            "pi-verify",
          ),
        ),
      );
      const piVerifyEvents = await collectAgentEvents(piVerify.events());
      expectSuccessfulCompletion(piVerifyEvents, piVerifiedMarker);
      const finalFileProbe = await runSandboxCommand(
        sandbox,
        "Pi final file continuity verification",
        `node -e 'const fs=require("fs");const lines=fs.readFileSync("/workspace/agent-online-e2e.txt","utf8").split(/\\r?\\n/).filter(Boolean);if(JSON.stringify(lines)!==JSON.stringify(["${piCreatedMarker}","${gooseUpdatedMarker}","${piVerifiedMarker}"]))process.exit(1)'`,
        { cwd: "/workspace", timeoutMs: 30_000 },
        redactOutput,
      );
      expect(finalFileProbe.exitCode).toBe(0);

      const cancelledGoose = await gooseRuntime.start(
        context,
        createAgentRunInput(
          "goose-cancel",
          `Run exactly this shell command and do not reply until it finishes: touch ${gooseCancellationMarkerPath} && sleep 60`,
          await issueModelAccess(
            capabilityCodec,
            capabilityTokens,
            secretsToRedact,
            `${tunnel.publicUrl}/v1`,
            "goose-cancel",
          ),
        ),
      );
      const cancelledEventsPromise = collectAgentEvents(cancelledGoose.events());
      await waitForSandboxFile(sandbox, gooseCancellationMarkerPath, 30_000);
      await cancelledGoose.cancel("cancelled");
      const cancelledEvents = await cancelledEventsPromise;
      expect(cancelledEvents.at(-1)).toMatchObject({
        agentRuntimeId: "goose",
        type: "agent.completed",
      });
      expect(
        (cancelledEvents.at(-1) as Extract<AgentEvent, { type: "agent.completed" }>).exitCode,
      ).not.toBe(0);
      const postCancelProbe = await runSandboxCommand(
        sandbox,
        "sandbox reuse after Goose cancellation",
        `test -r /workspace/agent-online-e2e.txt && test -w /workspace`,
        { cwd: "/workspace", timeoutMs: 30_000 },
        redactOutput,
      );
      expect(postCancelProbe.exitCode).toBe(0);

      const piProviderConfig = await sandbox.files.read(
        "/tmp/agent-online-pi/pi-create/models.json",
      );
      const gooseProviderConfig = await sandbox.files.read(
        "/tmp/agent-online-goose/goose-update/config/custom_providers/agent_online.json",
      );
      expect(new Set(capabilityTokens.values()).size).toBe(4);
      for (const capabilityToken of capabilityTokens.values()) {
        expect(String(piProviderConfig)).not.toContain(capabilityToken);
        expect(String(gooseProviderConfig)).not.toContain(capabilityToken);
      }
      expect(usage.length).toBeGreaterThanOrEqual(3);
      expect(
        usage.reduce((total, entry) => total + entry.modelRequestCount, 0),
      ).toBeGreaterThanOrEqual(3);
      expect(usage.reduce((total, entry) => total + entry.totalTokens, 0)).toBeGreaterThan(0);
      expect(new Set(usage.map((entry) => entry.runId))).toEqual(
        new Set(["pi-create", "goose-update", "pi-verify", "goose-cancel"]),
      );
    } finally {
      if (runtime && runtimeHandle) {
        await runtime.stop(runtimeHandle, "manual");
      } else if (sandbox) {
        await sandbox.kill();
      }
      if (tunnel) {
        await tunnel.close();
      }
      await localGateway.close();
    }
  }, 360_000);
});

function createAgentExecutionContext(
  runtime: E2BSandboxRuntime,
  handle: RuntimeHandle,
): AgentExecutionContext {
  return {
    files: {
      write: (path, content) => runtime.writeFile(handle, path, content),
    },
    processes: {
      start: (command) => runtime.startProcess(handle, command),
    },
  };
}

function createAgentRunInput(
  agentRunId: string,
  prompt: string,
  modelAccess: NonNullable<AgentRunInput["modelAccess"]>,
): AgentRunInput {
  return {
    agentRunId,
    modelAccess,
    projectId: "spike-project",
    prompt,
    sandboxLeaseId: "spike-lease",
    workingDirectory: "/workspace",
  };
}

async function collectAgentEvents(events: AsyncIterable<AgentEvent>) {
  const collected: AgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function expectSuccessfulCompletion(events: AgentEvent[], marker: string) {
  const completed = events.at(-1);
  expect(completed).toMatchObject({
    exitCode: 0,
    type: "agent.completed",
  });
  if (completed?.type !== "agent.completed") {
    throw new Error("AgentRuntime did not emit a completion event");
  }
  expect(completed.finalText).toContain(marker);
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function issueModelAccess(
  capabilityCodec: ReturnType<typeof createRunCapabilityCodec>,
  capabilityTokens: Map<string, string>,
  secretsToRedact: string[],
  baseUrl: string,
  runId: string,
): Promise<NonNullable<AgentRunInput["modelAccess"]>> {
  const issuedAt = new Date();
  const bearerToken = await capabilityCodec.issue({
    expiresAt: new Date(issuedAt.getTime() + 5 * 60_000),
    issuedAt,
    maxOutputTokens: 512,
    modelId,
    projectId: "spike-project",
    runId,
  });
  capabilityTokens.set(runId, bearerToken);
  secretsToRedact.push(bearerToken);
  return {
    baseUrl,
    bearerToken,
    maxOutputTokens: 512,
    modelId,
  };
}

async function waitForSandboxFile(sandbox: Sandbox, path: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await sandbox.files.exists(path)) {
      return;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for sandbox file: ${path}`);
}

type LocalGateway = {
  close(): Promise<void>;
  url: string;
};

type QuickTunnel = {
  close(): Promise<void>;
  publicUrl: string;
};

async function startLocalGateway(
  handler: (request: Request) => Promise<Response>,
): Promise<LocalGateway> {
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
    const timeout = setTimeout(
      () => finish(new Error("Timed out waiting for Cloudflare Quick Tunnel.")),
      30_000,
    );
    const inspect = (chunk: Buffer) => {
      const match = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match) {
        finish(undefined, match[0]);
      }
    };
    const fail = () =>
      finish(
        new Error(
          "Cloudflare Quick Tunnel could not start. Set CLOUDFLARED_BIN or install cloudflared.",
        ),
      );
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
      } else if (publicUrl) {
        resolve(publicUrl);
      } else {
        reject(new Error("Unable to resolve the local ModelGateway URL"));
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
    ...(body.length > 0 ? { body: body as unknown as BodyInit } : {}),
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
      throw new Error(
        `${label} failed with exit code ${error.exitCode}: ${output.slice(0, 2_000) || "no output"}`,
      );
    }

    throw error;
  }
}

function createOutputRedactor(values: string[]) {
  return (value: string) =>
    values.reduce(
      (redacted, secret) => redacted.split(secret).join("[redacted]"),
      value.replace(/AIza[\w-]+/g, "[redacted]"),
    );
}
