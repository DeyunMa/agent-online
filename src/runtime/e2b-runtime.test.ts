import {
  FileType,
  SandboxNotFoundError,
  type CommandStartOpts,
  type EntryInfo,
  type SandboxConnectOpts,
  type SandboxOpts,
} from "e2b";
import { describe, expect, it, vi } from "vitest";

import { SandboxNotRepositoryError, SandboxUnavailableError } from "./contract";
import { E2BSandboxRuntime, type E2BSandboxClient } from "./e2b-runtime";
import { maxGitDiffSectionBytes } from "./git-changes";

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
        network: {
          allowPublicTraffic: false,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: E2B expands this port placeholder.
          maskRequestHost: "localhost:${PORT}",
        },
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

  it("maps an E2B PTY to the explicit terminal capability", async () => {
    const sandbox = new FakeE2BSandbox("sandbox-existing");
    const runtime = createRuntime(new FakeE2BClient(sandbox));
    const handle = await runtime.ensureLease({
      projectId: "project-1",
      providerRef: "sandbox-existing",
      sandboxLeaseId: "lease-1",
    });

    const terminal = await runtime.startTerminal(handle, {
      cols: 96,
      cwd: "/workspace",
      rows: 28,
    });
    await terminal.write(new TextEncoder().encode("pwd\r"));
    await terminal.resize({ cols: 120, rows: 36 });
    const events = [];
    for await (const event of terminal.events()) {
      events.push(event);
    }

    expect(terminal.providerProcessRef).toBe("42");
    expect(sandbox.ptyOptions).toMatchObject({
      cols: 96,
      cwd: "/workspace",
      rows: 28,
      timeoutMs: 3_000,
    });
    expect(sandbox.terminalInputs).toEqual([
      { data: new TextEncoder().encode("pwd\r"), processId: 42 },
    ]);
    expect(sandbox.terminalSizes).toEqual([{ processId: 42, size: { cols: 120, rows: 36 } }]);
    expect(events).toEqual([
      {
        chunk: new TextEncoder().encode("terminal output"),
        sandboxLeaseId: "lease-1",
        type: "terminal.output",
      },
      {
        exitCode: 0,
        sandboxLeaseId: "lease-1",
        type: "terminal.exited",
      },
    ]);
  });

  it("starts and proxies only the private fixed Vite Preview preset", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, _init) =>
        new Response("<h1>Preview</h1>", {
          headers: { "content-type": "text/html" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const sandbox = new FakeE2BSandbox("sandbox-existing");
      const runtime = createRuntime(new FakeE2BClient(sandbox));
      const handle = await runtime.ensureLease({
        projectId: "project-1",
        providerRef: "sandbox-existing",
        sandboxLeaseId: "lease-1",
      });

      const contentBasePath = "/api/projects/project-1/preview/content/capability/";
      const started = await runtime.startPreview(handle, {
        contentBasePath,
        port: 3000,
        preset: "vite-v1",
        processTimeoutMs: 1_815_000,
        startupTimeoutMs: 2_000,
      });
      const response = await runtime.fetchPreview(handle, 3000, {
        headers: { accept: "text/html" },
        method: "GET",
        pathAndQuery: `${contentBasePath}assets/app.js?v=1`,
      });

      expect(started).toEqual({ providerProcessRef: "42" });
      expect(sandbox.command).toBe(
        "'/opt/agent-online/preview/node_modules/.bin/vite' '--host' '0.0.0.0' '--port' '3000' '--strictPort' '--config' '/tmp/agent-online-vite-preview.config.mjs' '--base' '/api/projects/project-1/preview/content/capability/'",
      );
      expect(sandbox.commandOptions).toMatchObject({
        background: true,
        cwd: "/workspace",
        envs: {
          BROWSER: "none",
          HOST: "0.0.0.0",
          PORT: "3000",
        },
        timeoutMs: 1_815_000,
      });
      expect(sandbox.process.disconnected).toBe(true);
      expect(sandbox.fileWrites).toEqual([
        {
          content: expect.stringContaining("hmr: false"),
          path: "/tmp/agent-online-vite-preview.config.mjs",
        },
      ]);
      expect(sandbox.fileWrites[0]?.content).not.toContain("watch: null");
      expect(response.status).toBe(200);
      const proxyCall = fetchMock.mock.calls.at(-1);
      expect(proxyCall?.[0]).toBe(
        "https://3000-sandbox-existing.example.test/api/projects/project-1/preview/content/capability/assets/app.js?v=1",
      );
      expect(new Headers(proxyCall?.[1]?.headers).get("e2b-traffic-access-token")).toBe(
        "traffic-token",
      );
      expect(proxyCall?.[1]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("classifies Preview entry and dependency prerequisites without starting a process", async () => {
    const sandbox = new FakeE2BSandbox("sandbox-existing");
    const runtime = createRuntime(new FakeE2BClient(sandbox));
    const handle = await runtime.ensureLease({
      projectId: "project-1",
      providerRef: "sandbox-existing",
      sandboxLeaseId: "lease-1",
    });

    await expect(runtime.inspectPreview(handle)).resolves.toEqual({
      kind: "entry_missing",
    });

    sandbox.fileEntries = [fileEntry("index.html"), fileEntry("package.json", 58)];
    sandbox.fileContents.set(
      "/workspace/package.json",
      new TextEncoder().encode('{"dependencies":{"react":"19.2.8"}}'),
    );
    await expect(runtime.inspectPreview(handle)).resolves.toEqual({
      kind: "dependencies_missing",
    });

    sandbox.fileEntries.push(fileEntry("node_modules", 0, FileType.DIR));
    await expect(runtime.inspectPreview(handle)).resolves.toEqual({
      kind: "ready",
    });
    expect(sandbox.commandHistory).toHaveLength(0);
  });

  it("does not treat an upstream 404 as Preview readiness", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not found", { status: 404 })),
    );
    try {
      const sandbox = new FakeE2BSandbox("sandbox-existing");
      const runtime = createRuntime(new FakeE2BClient(sandbox));
      const handle = await runtime.ensureLease({
        projectId: "project-1",
        providerRef: "sandbox-existing",
        sandboxLeaseId: "lease-1",
      });

      await expect(
        runtime.startPreview(handle, {
          contentBasePath: "/api/projects/project-1/preview/content/capability/",
          port: 3000,
          preset: "vite-v1",
          processTimeoutMs: 30_000,
          startupTimeoutMs: 1,
        }),
      ).rejects.toMatchObject({
        name: "E2BPreviewStartError.wait_ready.SandboxPreviewUnavailableError",
      });
      expect(sandbox.killedProcessIds).toEqual([42]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to a fixed command when Preview config file RPCs fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<h1>Ready</h1>", {
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    try {
      const sandbox = new FakeE2BSandbox("sandbox-existing");
      sandbox.fileWriteErrorsRemaining = 2;
      const client = new FakeE2BClient(sandbox);
      const runtime = createRuntime(client);
      const handle = await runtime.ensureLease({
        projectId: "project-1",
        providerRef: "sandbox-existing",
        sandboxLeaseId: "lease-1",
      });

      await expect(
        runtime.startPreview(handle, {
          contentBasePath: "/api/projects/project-1/preview/content/capability/",
          port: 3000,
          preset: "vite-v1",
          processTimeoutMs: 30_000,
          startupTimeoutMs: 2_000,
        }),
      ).resolves.toEqual({ providerProcessRef: "42" });

      expect(client.connected).toEqual(["sandbox-existing", "sandbox-existing"]);
      expect(sandbox.fileWrites).toHaveLength(0);
      expect(sandbox.commandHistory).toHaveLength(2);
      expect(sandbox.commandHistory[0]).toContain("'/bin/sh' '-c'");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("terminates a persisted PTY reference through the terminal capability", async () => {
    const sandbox = new FakeE2BSandbox("sandbox-existing");
    const runtime = createRuntime(new FakeE2BClient(sandbox));
    const handle = await runtime.ensureLease({
      projectId: "project-1",
      providerRef: "sandbox-existing",
      sandboxLeaseId: "lease-1",
    });

    await runtime.terminateTerminal(handle, "42", "expired");

    expect(sandbox.killedTerminalIds).toEqual([42]);
    expect(sandbox.killed).toBe(false);
  });

  it("treats an already-exited PTY as terminated", async () => {
    const sandbox = new FakeE2BSandbox("sandbox-existing");
    sandbox.terminalKillResult = false;
    const runtime = createRuntime(new FakeE2BClient(sandbox));
    const handle = await runtime.ensureLease({
      projectId: "project-1",
      providerRef: "sandbox-existing",
      sandboxLeaseId: "lease-1",
    });

    await expect(runtime.terminateTerminal(handle, "42", "expired")).resolves.toBeUndefined();
  });

  it("rejects a PTY that exceeds its bounded output budget", async () => {
    const sandbox = new FakeE2BSandbox("sandbox-existing");
    const runtime = new E2BSandboxRuntime({
      apiKey: "test-e2b-key",
      client: new FakeE2BClient(sandbox),
      sandboxTimeoutMs: 1_000,
      templateId: "template-1",
      terminalOutputLimitBytes: 4,
      terminalPendingOutputBytes: 32,
      terminalTimeoutMs: 3_000,
    });
    const handle = await runtime.ensureLease({
      projectId: "project-1",
      providerRef: "sandbox-existing",
      sandboxLeaseId: "lease-1",
    });

    await expect(
      runtime.startTerminal(handle, {
        cols: 80,
        cwd: "/workspace",
        rows: 24,
      }),
    ).rejects.toThrow("output limit");
  });

  it("maps provider file metadata and bytes to the generic filesystem contract", async () => {
    const sandbox = new FakeE2BSandbox("sandbox-existing");
    const runtime = createRuntime(new FakeE2BClient(sandbox));
    const handle = await runtime.ensureLease({
      projectId: "project-1",
      providerRef: "sandbox-existing",
      sandboxLeaseId: "lease-1",
    });

    await expect(runtime.listDirectory(handle, "/workspace")).resolves.toEqual([
      {
        kind: "file",
        modifiedAt: null,
        name: "example.txt",
        size: 7,
      },
    ]);
    await expect(runtime.readFile(handle, "/workspace/example.txt")).resolves.toEqual(
      new TextEncoder().encode("example"),
    );
  });

  it("runs only bounded fixed Git commands for Changes", async () => {
    const sandbox = new FakeE2BSandbox("sandbox-existing");
    sandbox.commandResults.push(
      {
        exitCode: 0,
        stderr: "",
        stdout: "",
      },
      {
        exitCode: 0,
        stderr: "",
        stdout: " M quote's.ts\0",
      },
      {
        exitCode: 0,
        stderr: "",
        stdout: "",
      },
      {
        exitCode: 0,
        stderr: "",
        stdout: "@@ -1 +1 @@\n-old\n+new\n",
      },
    );
    const runtime = createRuntime(new FakeE2BClient(sandbox));
    const handle = await runtime.ensureLease({
      projectId: "project-1",
      providerRef: "sandbox-existing",
      sandboxLeaseId: "lease-1",
    });

    const changes = await runtime.listChanges(handle);
    const change = changes.entries[0];
    if (!change) {
      throw new Error("Expected a changed path");
    }
    const diff = await runtime.readChangeDiff(handle, change);

    expect(changes).toEqual({
      entries: [
        {
          path: "quote's.ts",
          previousPath: null,
          stagedKind: null,
          unstagedKind: "modified",
        },
      ],
      truncated: false,
      unsupportedEntries: false,
    });
    expect(diff).toEqual({
      staged: null,
      unstaged: {
        content: "@@ -1 +1 @@\n-old\n+new\n",
        truncated: false,
      },
    });
    expect(sandbox.commandHistory).toHaveLength(4);
    expect(sandbox.commandHistory[0]).toContain(
      "'config' '--file' '/workspace/.git/config' '--no-includes'",
    );
    expect(sandbox.commandHistory[1]).toContain("'status' '--porcelain=v1' '-z'");
    expect(sandbox.commandHistory[3]).toContain(
      "'diff' '--no-color' '--no-ext-diff' '--no-textconv'",
    );
    expect(sandbox.commandHistory[3]).toContain("'quote'\"'\"'s.ts'");
    expect(sandbox.commandHistory[1]).toContain(
      "'/usr/bin/env' '-i' 'AGENT_ONLINE_OUTPUT_LIMIT=131073'",
    );
    expect(sandbox.commandHistory[1]).toContain("GIT_NO_LAZY_FETCH=1");
    expect(sandbox.commandHistory[1]).toContain("/usr/bin/head -c");
    expect(sandbox.commandHistory[1]).toContain('"$GIT_DIR/commondir"');
    expect(sandbox.commandHistory[1]).toContain('"$GIT_DIR/config.worktree"');
    expect(sandbox.commandHistory[1]).not.toContain("mktemp");
    expect(sandbox.commandOptionHistory).toHaveLength(4);
    expect(sandbox.commandOptionHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cwd: "/workspace",
          timeoutMs: 15_000,
        }),
      ]),
    );
  });

  it("reports a workspace without a local .git directory as a non-repository", async () => {
    const sandbox = new FakeE2BSandbox("sandbox-existing");
    sandbox.commandResults.push({
      exitCode: 44,
      stderr: "",
      stdout: "",
    });
    const runtime = createRuntime(new FakeE2BClient(sandbox));
    const handle = await runtime.ensureLease({
      projectId: "project-1",
      providerRef: "sandbox-existing",
      sandboxLeaseId: "lease-1",
    });

    await expect(runtime.listChanges(handle)).rejects.toBeInstanceOf(SandboxNotRepositoryError);
  });

  it.each([
    "diff.custom.textconv",
    "extensions.worktreeConfig",
    "filter.danger.clean",
    "include.path",
  ])("rejects unsafe repository configuration %s before reading status", async (unsafeKey) => {
    const sandbox = new FakeE2BSandbox("sandbox-existing");
    sandbox.commandResults.push({
      exitCode: 0,
      stderr: "",
      stdout: `${unsafeKey}\0`,
    });
    const runtime = createRuntime(new FakeE2BClient(sandbox));
    const handle = await runtime.ensureLease({
      projectId: "project-1",
      providerRef: "sandbox-existing",
      sandboxLeaseId: "lease-1",
    });

    await expect(runtime.listChanges(handle)).rejects.toThrow("not safe");
    expect(sandbox.commandHistory).toHaveLength(1);
  });

  it.each([46, 47])("rejects repository config scope exit code %i", async (exitCode) => {
    const sandbox = new FakeE2BSandbox("sandbox-existing");
    sandbox.commandResults.push({
      exitCode,
      stderr: "",
      stdout: "",
    });
    const runtime = createRuntime(new FakeE2BClient(sandbox));
    const handle = await runtime.ensureLease({
      projectId: "project-1",
      providerRef: "sandbox-existing",
      sandboxLeaseId: "lease-1",
    });

    await expect(runtime.listChanges(handle)).rejects.toThrow("validation failed");
    expect(sandbox.commandHistory).toHaveLength(1);
  });

  it("returns a bounded diff when Git exits on the fixed head limit", async () => {
    const sandbox = new FakeE2BSandbox("sandbox-existing");
    sandbox.commandResults.push(
      { exitCode: 0, stderr: "", stdout: "" },
      {
        exitCode: 0,
        stderr: "",
        stdout: " M large.txt\0",
      },
      { exitCode: 0, stderr: "", stdout: "" },
      {
        exitCode: 141,
        stderr: "",
        stdout: "x".repeat(maxGitDiffSectionBytes + 1),
      },
    );
    const runtime = createRuntime(new FakeE2BClient(sandbox));
    const handle = await runtime.ensureLease({
      projectId: "project-1",
      providerRef: "sandbox-existing",
      sandboxLeaseId: "lease-1",
    });
    const changes = await runtime.listChanges(handle);
    const change = changes.entries[0];
    if (!change) {
      throw new Error("Expected a changed path");
    }
    const diff = await runtime.readChangeDiff(handle, change);

    expect(diff.unstaged?.truncated).toBe(true);
    expect(new TextEncoder().encode(diff.unstaged?.content).byteLength).toBe(
      maxGitDiffSectionBytes,
    );
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

    await expect(runtime.terminateProcess(handle, "42", "cancelled")).rejects.toThrow(
      "process was not found",
    );
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

  it("converges Preview operations when the recorded sandbox has expired", async () => {
    const client = new FakeE2BClient(new FakeE2BSandbox("sandbox-expired"));
    client.connectError = new SandboxNotFoundError("expired");
    const runtime = createRuntime(client);
    const handle = {
      id: "sandbox-expired",
      kind: "e2b" as const,
      sandboxLeaseId: "lease-1",
    };

    await expect(runtime.isPreviewRunning(handle, "42", 3000)).resolves.toBe(false);
    await expect(runtime.terminatePreview(handle, "42", "expired")).resolves.toBeUndefined();
    await expect(
      runtime.fetchPreview(handle, 3000, {
        headers: {},
        method: "GET",
        pathAndQuery: "/api/projects/project-1/preview/content/token/",
      }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
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
  readonly commandHistory: string[] = [];
  readonly commandOptionHistory: Array<CommandStartOpts & { background: true }> = [];
  readonly commandResults: Array<{
    exitCode: number;
    stderr: string;
    stdout: string;
  }> = [];
  commandOptions: (CommandStartOpts & { background: true }) | null = null;
  fileWriteErrorsRemaining = 0;
  killed = false;
  processKillResult = true;
  terminalKillResult = true;
  readonly killedProcessIds: number[] = [];
  readonly killedTerminalIds: number[] = [];
  readonly process = new FakeE2BCommandHandle();
  ptyOptions: {
    cols: number;
    cwd: string;
    onData(data: Uint8Array): void | Promise<void>;
    rows: number;
    timeoutMs: number;
  } | null = null;
  readonly terminalInputs: Array<{ data: Uint8Array; processId: number }> = [];
  readonly terminalSizes: Array<{
    processId: number;
    size: { cols: number; rows: number };
  }> = [];
  readonly timeoutValues: number[] = [];
  readonly fileWrites: Array<{ content: string; path: string }> = [];
  fileEntries: EntryInfo[] = [fileEntry("example.txt")];
  readonly fileContents = new Map<string, Uint8Array>([
    ["/workspace/example.txt", new TextEncoder().encode("example")],
  ]);
  readonly files = {
    list: async (_path: string) => this.fileEntries,
    read: async (path: string, _options: { format: "bytes" }) =>
      this.fileContents.get(path) ?? new TextEncoder().encode("example"),
    write: async (path: string, content: string) => {
      if (this.fileWriteErrorsRemaining > 0) {
        this.fileWriteErrorsRemaining -= 1;
        throw new Error("Transient file write failure");
      }
      this.fileWrites.push({ content, path });
    },
  };

  readonly commands = {
    kill: async (processId: number) => {
      this.killedProcessIds.push(processId);
      return this.processKillResult;
    },
    list: async () => [{ pid: this.process.pid }],
    run: async (command: string, options: CommandStartOpts & { background: true }) => {
      this.command = command;
      this.commandHistory.push(command);
      this.commandOptions = options;
      this.commandOptionHistory.push(options);
      await options.onStdout?.("stdout");
      await options.onStderr?.("stderr");
      const result = this.commandResults.shift();
      return result ? new FakeE2BCommandHandle(result) : this.process;
    },
  };
  readonly pty = {
    create: async (options: NonNullable<FakeE2BSandbox["ptyOptions"]>) => {
      this.ptyOptions = options;
      await options.onData(new TextEncoder().encode("terminal output"));
      return this.process;
    },
    kill: async (processId: number) => {
      this.killedTerminalIds.push(processId);
      return this.terminalKillResult;
    },
    resize: async (processId: number, size: { cols: number; rows: number }) => {
      this.terminalSizes.push({ processId, size });
    },
    sendInput: async (processId: number, data: Uint8Array) => {
      this.terminalInputs.push({ data, processId });
    },
  };

  constructor(readonly sandboxId: string) {}

  getHost(port: number) {
    return `${port}-${this.sandboxId}.example.test`;
  }

  readonly trafficAccessToken = "traffic-token";

  async kill() {
    this.killed = true;
    return true;
  }

  async setTimeout(timeoutMs: number) {
    this.timeoutValues.push(timeoutMs);
  }
}

function fileEntry(name: string, size = 7, type = FileType.FILE): EntryInfo {
  return {
    group: "e2b",
    mode: type === FileType.DIR ? 0o755 : 0o644,
    name,
    owner: "e2b",
    path: `/workspace/${name}`,
    permissions: type === FileType.DIR ? "rwxr-xr-x" : "rw-r--r--",
    size,
    type,
  };
}

class FakeE2BCommandHandle {
  disconnected = false;
  readonly pid = 42;
  readonly stdin: string[] = [];

  constructor(
    private readonly result = {
      exitCode: 0,
      stderr: "stderr",
      stdout: "stdout",
    },
  ) {}

  async disconnect() {
    this.disconnected = true;
  }

  async kill() {
    return true;
  }

  async sendStdin(input: string | Uint8Array) {
    this.stdin.push(typeof input === "string" ? input : new TextDecoder().decode(input));
  }

  async wait() {
    return this.result;
  }
}

function createRuntime(client: E2BSandboxClient) {
  return new E2BSandboxRuntime({
    apiKey: "test-e2b-key",
    client,
    processTimeoutMs: 2_000,
    sandboxTimeoutMs: 1_000,
    templateId: "template-1",
    terminalTimeoutMs: 3_000,
  });
}
