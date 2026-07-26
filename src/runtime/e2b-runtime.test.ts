import { SandboxNotFoundError, type CommandStartOpts, type SandboxConnectOpts, type SandboxOpts } from "e2b";
import { describe, expect, it } from "vitest";

import { E2BSandboxRuntime, type E2BSandboxClient } from "./e2b-runtime";

describe("E2BSandboxRuntime", () => {
  it("creates a sandbox and maps command IO to the generic process contract", async () => {
    const sandbox = new FakeE2BSandbox("sandbox-1");
    const client = new FakeE2BClient(sandbox);
    const runtime = createRuntime(client);
    const handle = await runtime.ensureLease({
      projectId: "project-1",
      providerRef: null,
      sandboxLeaseId: "lease-1",
    });
    const session = await runtime.startProcess(handle, {
      agentRunId: "run-1",
      args: ["--mode", "rpc", "quote's"],
      command: "pi",
      cwd: "/workspace",
      env: { RUN_CAPABILITY: "opaque-token" },
    });
    await session.write('{"type":"prompt"}\n');
    const events = [];

    for await (const event of session.events()) {
      events.push(event);
    }

    expect(client.created).toMatchObject({
      options: {
        metadata: { app: "agent-online", projectId: "project-1", sandboxLeaseId: "lease-1" },
        timeoutMs: 1_000,
      },
      templateId: "template-1",
    });
    expect(sandbox.command).toBe("'pi' '--mode' 'rpc' 'quote'\"'\"'s'");
    expect(sandbox.commandOptions).toMatchObject({
      background: true,
      cwd: "/workspace",
      envs: { RUN_CAPABILITY: "opaque-token" },
      stdin: true,
      timeoutMs: 2_000,
    });
    expect(sandbox.process.stdin).toEqual(['{"type":"prompt"}\n']);
    expect(session.providerProcessRef).toBe("42");
    expect(events).toEqual([
      { processId: "42", sandboxLeaseId: "lease-1", type: "process.started" },
      { chunk: "stdout", sandboxLeaseId: "lease-1", stream: "stdout", type: "process.output" },
      { chunk: "stderr", sandboxLeaseId: "lease-1", stream: "stderr", type: "process.output" },
      { exitCode: 0, sandboxLeaseId: "lease-1", type: "process.completed" },
    ]);
  });

  it("reconnects a live provider reference and refreshes its timeout", async () => {
    const sandbox = new FakeE2BSandbox("sandbox-existing");
    const client = new FakeE2BClient(sandbox);
    const runtime = createRuntime(client);

    const handle = await runtime.ensureLease({
      projectId: "project-1",
      providerRef: "sandbox-existing",
      sandboxLeaseId: "lease-1",
    });

    expect(handle).toEqual({ id: "sandbox-existing", kind: "e2b", sandboxLeaseId: "lease-1" });
    expect(client.connected).toEqual(["sandbox-existing"]);
    expect(client.created).toBeNull();
    expect(sandbox.timeoutValues).toEqual([1_000]);
  });

  it("terminates a persisted process reference without stopping the sandbox", async () => {
    const sandbox = new FakeE2BSandbox("sandbox-existing");
    const runtime = createRuntime(new FakeE2BClient(sandbox));
    const handle = await runtime.ensureLease({
      projectId: "project-1",
      providerRef: "sandbox-existing",
      sandboxLeaseId: "lease-1",
    });

    await runtime.terminateProcess(handle, "42", "cancelled");

    expect(sandbox.killedProcessIds).toEqual([42]);
    expect(sandbox.killed).toBe(false);
  });

  it("reports a missing persisted process so cancellation can stop the sandbox", async () => {
    const sandbox = new FakeE2BSandbox("sandbox-existing");
    sandbox.processKillResult = false;
    const runtime = createRuntime(new FakeE2BClient(sandbox));
    const handle = await runtime.ensureLease({
      projectId: "project-1",
      providerRef: "sandbox-existing",
      sandboxLeaseId: "lease-1",
    });

    await expect(
      runtime.terminateProcess(handle, "42", "cancelled"),
    ).rejects.toThrow("process was not found");
  });

  it("replaces an expired provider reference and treats an already-gone sandbox as stopped", async () => {
    const sandbox = new FakeE2BSandbox("sandbox-new");
    const client = new FakeE2BClient(sandbox);
    client.connectError = new SandboxNotFoundError("expired");
    const runtime = createRuntime(client);

    const handle = await runtime.ensureLease({
      projectId: "project-1",
      providerRef: "sandbox-expired",
      sandboxLeaseId: "lease-1",
    });
    await runtime.stop({ id: "already-gone", kind: "e2b", sandboxLeaseId: "lease-1" }, "idle");

    expect(handle).toEqual({ id: "sandbox-new", kind: "e2b", sandboxLeaseId: "lease-1" });
    expect(client.created?.templateId).toBe("template-1");
  });
});

class FakeE2BClient implements E2BSandboxClient {
  connected: string[] = [];
  connectError: Error | null = null;
  created: { options: SandboxOpts; templateId: string } | null = null;

  constructor(private readonly sandbox: FakeE2BSandbox) {}

  async connect(sandboxId: string, _options: SandboxConnectOpts) {
    this.connected.push(sandboxId);
    if (this.connectError) {
      throw this.connectError;
    }

    return this.sandbox;
  }

  async create(templateId: string, options: SandboxOpts) {
    this.created = { options, templateId };
    return this.sandbox;
  }
}

class FakeE2BSandbox {
  command = "";
  commandOptions: (CommandStartOpts & { background: true }) | null = null;
  killed = false;
  processKillResult = true;
  readonly killedProcessIds: number[] = [];
  readonly process = new FakeE2BCommandHandle();
  readonly timeoutValues: number[] = [];
  readonly files = {
    write: async (_path: string, _content: string) => undefined,
  };

  readonly commands = {
    kill: async (processId: number) => {
      this.killedProcessIds.push(processId);
      return this.processKillResult;
    },
    run: async (command: string, options: CommandStartOpts & { background: true }) => {
      this.command = command;
      this.commandOptions = options;
      await options.onStdout?.("stdout");
      await options.onStderr?.("stderr");
      return this.process;
    },
  };

  constructor(readonly sandboxId: string) {}

  async kill() {
    this.killed = true;
    return true;
  }

  async setTimeout(timeoutMs: number) {
    this.timeoutValues.push(timeoutMs);
  }
}

class FakeE2BCommandHandle {
  readonly pid = 42;
  readonly stdin: string[] = [];

  async kill() {
    return true;
  }

  async sendStdin(input: string | Uint8Array) {
    this.stdin.push(typeof input === "string" ? input : new TextDecoder().decode(input));
  }

  async wait() {
    return {
      exitCode: 0,
      stderr: "stderr",
      stdout: "stdout",
    };
  }
}

function createRuntime(client: E2BSandboxClient) {
  return new E2BSandboxRuntime({
    apiKey: "test-e2b-key",
    client,
    processTimeoutMs: 2_000,
    sandboxTimeoutMs: 1_000,
    templateId: "template-1",
  });
}
