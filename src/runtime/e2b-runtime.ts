import {
  CommandExitError,
  FileNotFoundError,
  FileType,
  Sandbox,
  SandboxNotFoundError,
  type CommandHandle,
  type CommandResult,
  type CommandStartOpts,
  type EntryInfo,
  type SandboxConnectOpts,
  type SandboxOpts,
} from "e2b";

import type {
  EnsureLeaseInput,
  ProcessTerminationReason,
  RuntimeHandle,
  SandboxChangeDiff,
  SandboxChangeEntry,
  SandboxChangesRuntime,
  SandboxCommand,
  SandboxFileEntry,
  SandboxProcessEvent,
  SandboxProcessSession,
  SandboxPreviewRequest,
  SandboxPreviewRuntime,
  SandboxPreviewStartInput,
  SandboxRuntime,
  SandboxStopReason,
  SandboxTerminalEvent,
  SandboxTerminalRuntime,
  SandboxTerminalSession,
  SandboxTerminalSize,
  TerminalCloseReason,
  PreviewStopReason,
} from "./contract";
import {
  isSupportedSandboxChangePath,
  SandboxNotRepositoryError,
  SandboxPathNotFoundError,
  SandboxPreviewUnavailableError,
  SandboxUnavailableError,
} from "./contract";
import {
  maxGitDiffSectionBytes,
  maxGitStatusBytes,
  parseGitStatusOutput,
  truncateUtf8,
} from "./git-changes";

type E2BCommandHandle = Pick<CommandHandle, "disconnect" | "kill" | "pid" | "sendStdin" | "wait">;

type E2BPty = {
  create(options: {
    cols: number;
    cwd: string;
    onData(data: Uint8Array): void | Promise<void>;
    rows: number;
    timeoutMs: number;
  }): Promise<E2BCommandHandle>;
  kill(pid: number): Promise<boolean>;
  resize(pid: number, size: SandboxTerminalSize): Promise<void>;
  sendInput(pid: number, data: Uint8Array): Promise<void>;
};

type E2BSandbox = {
  commands: {
    kill(pid: number): Promise<boolean>;
    list(): Promise<Array<{ pid: number }>>;
    run(
      command: string,
      options: CommandStartOpts & { background: true },
    ): Promise<E2BCommandHandle>;
  };
  files: {
    list(path: string): Promise<EntryInfo[]>;
    read(path: string, options: { format: "bytes" }): Promise<Uint8Array>;
    write(path: string, content: string): Promise<unknown>;
  };
  getHost(port: number): string;
  kill(): Promise<boolean>;
  pty: E2BPty;
  sandboxId: string;
  setTimeout(timeoutMs: number): Promise<void>;
  trafficAccessToken?: string;
};

export type E2BSandboxClient = {
  connect(sandboxId: string, options: SandboxConnectOpts): Promise<E2BSandbox>;
  create(templateId: string, options: SandboxOpts): Promise<E2BSandbox>;
};

export type E2BSandboxRuntimeOptions = {
  apiKey: string;
  changesTimeoutMs?: number;
  client?: E2BSandboxClient;
  processTimeoutMs?: number;
  sandboxTimeoutMs?: number;
  templateId: string;
  terminalOutputLimitBytes?: number;
  terminalPendingOutputBytes?: number;
  terminalTimeoutMs?: number;
};

const defaultSandboxTimeoutMs = 30 * 60 * 1_000;
const defaultProcessTimeoutMs = 30 * 60 * 1_000;
const defaultTerminalTimeoutMs = 30 * 60 * 1_000;
const defaultChangesTimeoutMs = 15_000;
const previewConfigPath = "/tmp/agent-online-vite-preview.config.mjs";
const previewConfig = `export default {
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
const previewPort = 3000;
const previewWorkingDirectory = "/workspace";
const changesWorkingDirectory = "/workspace";
const maxGitConfigBytes = 64 * 1_024;
export const defaultTerminalOutputLimitBytes = 8 * 1_024 * 1_024;
export const defaultTerminalPendingOutputBytes = 256 * 1_024;

const defaultClient: E2BSandboxClient = {
  connect: (sandboxId, options) => Sandbox.connect(sandboxId, options),
  create: (templateId, options) => Sandbox.create(templateId, options),
};

export class E2BSandboxRuntime
  implements SandboxChangesRuntime, SandboxPreviewRuntime, SandboxRuntime, SandboxTerminalRuntime
{
  readonly filesystemScope = "lease" as const;
  readonly kind = "e2b" as const;

  private readonly client: E2BSandboxClient;
  private readonly changesTimeoutMs: number;
  private readonly processTimeoutMs: number;
  private readonly sandboxTimeoutMs: number;
  private readonly terminalOutputLimitBytes: number;
  private readonly terminalPendingOutputBytes: number;
  private readonly terminalTimeoutMs: number;
  private readonly sandboxes = new Map<string, E2BSandbox>();

  constructor(private readonly options: E2BSandboxRuntimeOptions) {
    if (!options.apiKey || !options.templateId) {
      throw new Error("E2BSandboxRuntime requires apiKey and templateId");
    }

    this.client = options.client ?? defaultClient;
    this.changesTimeoutMs = requirePositiveTimeout(
      options.changesTimeoutMs ?? defaultChangesTimeoutMs,
    );
    this.processTimeoutMs = requirePositiveTimeout(
      options.processTimeoutMs ?? defaultProcessTimeoutMs,
    );
    this.sandboxTimeoutMs = requirePositiveTimeout(
      options.sandboxTimeoutMs ?? defaultSandboxTimeoutMs,
    );
    this.terminalOutputLimitBytes = requirePositiveTimeout(
      options.terminalOutputLimitBytes ?? defaultTerminalOutputLimitBytes,
    );
    this.terminalPendingOutputBytes = requirePositiveTimeout(
      options.terminalPendingOutputBytes ?? defaultTerminalPendingOutputBytes,
    );
    this.terminalTimeoutMs = requirePositiveTimeout(
      options.terminalTimeoutMs ?? defaultTerminalTimeoutMs,
    );
  }

  async ensureLease(input: EnsureLeaseInput): Promise<RuntimeHandle> {
    if (input.providerRef) {
      try {
        const existing = await this.client.connect(input.providerRef, {
          apiKey: this.options.apiKey,
        });
        await existing.setTimeout(this.sandboxTimeoutMs);
        this.sandboxes.set(existing.sandboxId, existing);
        return { id: existing.sandboxId, kind: this.kind, sandboxLeaseId: input.sandboxLeaseId };
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) {
          throw error;
        }
      }
    }

    const sandbox = await this.client.create(this.options.templateId, {
      apiKey: this.options.apiKey,
      metadata: {
        app: "agent-online",
        projectId: input.projectId,
        sandboxLeaseId: input.sandboxLeaseId,
      },
      network: {
        allowPublicTraffic: false,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: E2B expands this port placeholder.
        maskRequestHost: "localhost:${PORT}",
      },
      timeoutMs: this.sandboxTimeoutMs,
    });
    this.sandboxes.set(sandbox.sandboxId, sandbox);
    return { id: sandbox.sandboxId, kind: this.kind, sandboxLeaseId: input.sandboxLeaseId };
  }

  async startProcess(
    handle: RuntimeHandle,
    command: SandboxCommand,
  ): Promise<SandboxProcessSession> {
    const sandbox = this.requireSandbox(handle);
    const queue = new AsyncEventQueue<SandboxProcessEvent>();
    const bufferedOutput: SandboxProcessEvent[] = [];
    let started = false;
    const emitOutput = (event: SandboxProcessEvent) => {
      if (started) {
        queue.push(event);
      } else {
        bufferedOutput.push(event);
      }
    };
    const process = await sandbox.commands.run(toShellCommand(command), {
      background: true,
      cwd: command.cwd,
      envs: command.env ? { ...command.env } : undefined,
      onStderr: (chunk) => {
        emitOutput({
          chunk,
          sandboxLeaseId: handle.sandboxLeaseId,
          stream: "stderr",
          type: "process.output",
        });
      },
      onStdout: (chunk) => {
        emitOutput({
          chunk,
          sandboxLeaseId: handle.sandboxLeaseId,
          stream: "stdout",
          type: "process.output",
        });
      },
      stdin: true,
      timeoutMs: this.processTimeoutMs,
    });

    queue.push({
      processId: String(process.pid),
      sandboxLeaseId: handle.sandboxLeaseId,
      type: "process.started",
    });
    started = true;
    for (const event of bufferedOutput) {
      queue.push(event);
    }

    void settleProcess(process, handle.sandboxLeaseId, queue);
    return new E2BProcessSession(process, queue);
  }

  async startTerminal(
    handle: RuntimeHandle,
    input: SandboxTerminalSize & { cwd: string },
  ): Promise<SandboxTerminalSession> {
    const sandbox = await this.attachSandbox(handle);
    const queue = new AsyncEventQueue<SandboxTerminalEvent>({
      maxPendingSize: this.terminalPendingOutputBytes,
      sizeOf: terminalEventSize,
    });
    let outputBytes = 0;
    const process = await sandbox.pty.create({
      cols: input.cols,
      cwd: input.cwd,
      onData: async (chunk) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > this.terminalOutputLimitBytes) {
          const error = new Error("Terminal output limit exceeded");
          queue.fail(error);
          throw error;
        }
        await queue.pushWithBackpressure({
          chunk,
          sandboxLeaseId: handle.sandboxLeaseId,
          type: "terminal.output",
        });
      },
      rows: input.rows,
      timeoutMs: this.terminalTimeoutMs,
    });

    void settleTerminal(process, handle.sandboxLeaseId, queue);
    return new E2BTerminalSession(process, sandbox.pty, queue);
  }

  async listDirectory(handle: RuntimeHandle, path: string): Promise<SandboxFileEntry[]> {
    try {
      const sandbox = await this.attachSandbox(handle);
      const entries = await sandbox.files.list(path);
      return entries.map((entry) => ({
        kind: toSandboxFileEntryKind(entry.type),
        modifiedAt: entry.modifiedTime?.toISOString() ?? null,
        name: entry.name,
        size: entry.size,
      }));
    } catch (error) {
      throw mapFilesystemError(error, path);
    }
  }

  async listChanges(handle: RuntimeHandle) {
    try {
      const sandbox = await this.attachSandbox(handle);
      await assertSafeGitConfiguration(sandbox, this.changesTimeoutMs);
      const result = await runBoundedGitCommand(
        sandbox,
        changesWorkingDirectory,
        [
          "--no-pager",
          "--literal-pathspecs",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.untrackedCache=false",
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignore-submodules=all",
        ],
        maxGitStatusBytes + 1,
        this.changesTimeoutMs,
      );
      const bounded = truncateUtf8(result.stdout, maxGitStatusBytes);
      if (result.exitCode === 44) {
        throw new SandboxNotRepositoryError();
      }
      if (result.exitCode !== 0 && !(result.exitCode === 141 && bounded.truncated)) {
        throw new Error("Git status failed");
      }

      return parseGitStatusOutput(bounded.text, bounded.truncated);
    } catch (error) {
      if (error instanceof SandboxNotFoundError) {
        throw new SandboxUnavailableError();
      }
      throw error;
    }
  }

  async readChangeDiff(
    handle: RuntimeHandle,
    change: SandboxChangeEntry,
  ): Promise<SandboxChangeDiff> {
    assertSandboxChange(change);
    try {
      const sandbox = await this.attachSandbox(handle);
      await assertSafeGitConfiguration(sandbox, this.changesTimeoutMs);
      const staged = change.stagedKind
        ? await readGitDiffSection(
            sandbox,
            changesWorkingDirectory,
            createTrackedDiffArgs(change, true),
            this.changesTimeoutMs,
            false,
          )
        : null;
      const unstaged = change.unstagedKind
        ? await readGitDiffSection(
            sandbox,
            changesWorkingDirectory,
            change.unstagedKind === "untracked"
              ? createUntrackedDiffArgs(change.path)
              : createTrackedDiffArgs(change, false),
            this.changesTimeoutMs,
            change.unstagedKind === "untracked",
          )
        : null;

      return { staged, unstaged };
    } catch (error) {
      if (error instanceof SandboxNotFoundError) {
        throw new SandboxUnavailableError();
      }
      throw error;
    }
  }

  async readFile(handle: RuntimeHandle, path: string) {
    try {
      const sandbox = await this.attachSandbox(handle);
      return await sandbox.files.read(path, { format: "bytes" });
    } catch (error) {
      throw mapFilesystemError(error, path);
    }
  }

  async stop(handle: RuntimeHandle, _reason: SandboxStopReason) {
    assertRuntimeHandle(handle, this.kind);

    let sandbox = this.sandboxes.get(handle.id);
    if (!sandbox) {
      try {
        sandbox = await this.client.connect(handle.id, { apiKey: this.options.apiKey });
      } catch (error) {
        if (error instanceof SandboxNotFoundError) {
          return;
        }

        throw error;
      }
    }

    await sandbox.kill();
    this.sandboxes.delete(handle.id);
  }

  async terminateProcess(
    handle: RuntimeHandle,
    providerProcessRef: string,
    _reason: ProcessTerminationReason,
  ) {
    const sandbox = await this.attachSandbox(handle);
    const processId = parseProviderProcessRef(providerProcessRef, "process");

    const killed = await sandbox.commands.kill(processId);
    if (!killed) {
      throw new Error(`E2B process was not found: ${providerProcessRef}`);
    }
  }

  async terminateTerminal(
    handle: RuntimeHandle,
    providerProcessRef: string,
    _reason: TerminalCloseReason,
  ) {
    const sandbox = await this.attachSandbox(handle);
    const processId = parseProviderProcessRef(providerProcessRef, "terminal");
    await sandbox.pty.kill(processId);
  }

  async startPreview(handle: RuntimeHandle, input: SandboxPreviewStartInput) {
    assertPreviewStartInput(input);
    const preset = vitePreviewPreset(input.contentBasePath);
    let process: E2BCommandHandle | undefined;
    let sandbox: E2BSandbox | undefined;
    let stage:
      | "attach"
      | "command_start"
      | "disconnect"
      | "reconnect_after_write"
      | "traffic_token"
      | "wait_ready"
      | "write_config"
      | "write_config_command"
      | "write_config_retry" = "attach";
    try {
      sandbox = await this.attachSandbox(handle);
      stage = "traffic_token";
      if (!sandbox.trafficAccessToken) {
        sandbox = await this.client.connect(handle.id, {
          apiKey: this.options.apiKey,
        });
        this.sandboxes.set(sandbox.sandboxId, sandbox);
      }
      requireTrafficAccessToken(sandbox);
      stage = "write_config";
      try {
        await sandbox.files.write(previewConfigPath, previewConfig);
      } catch {
        stage = "reconnect_after_write";
        sandbox = await this.client.connect(handle.id, {
          apiKey: this.options.apiKey,
        });
        this.sandboxes.set(sandbox.sandboxId, sandbox);
        requireTrafficAccessToken(sandbox);
        stage = "write_config_retry";
        try {
          await sandbox.files.write(previewConfigPath, previewConfig);
        } catch {
          stage = "write_config_command";
          await writePreviewConfigWithCommand(sandbox);
        }
      }
      stage = "command_start";
      const startedProcess = await sandbox.commands.run(toShellCommand(preset), {
        background: true,
        cwd: preset.cwd,
        envs: { ...preset.env },
        timeoutMs: input.processTimeoutMs,
      });
      process = startedProcess;
      stage = "wait_ready";
      await waitForPreviewReady(
        sandbox,
        startedProcess.pid,
        input.port,
        input.contentBasePath,
        input.startupTimeoutMs,
      );
      stage = "disconnect";
      await startedProcess.disconnect();
      return { providerProcessRef: String(startedProcess.pid) };
    } catch (error) {
      if (sandbox && process) {
        await sandbox.commands.kill(process.pid).catch(() => false);
      }
      throw toPreviewStartError(stage, error);
    }
  }

  async isPreviewRunning(handle: RuntimeHandle, providerProcessRef: string, _port: number) {
    try {
      const sandbox = await this.attachSandbox(handle);
      const processId = parseProviderProcessRef(providerProcessRef, "preview");
      const processes = await sandbox.commands.list();
      return processes.some((process) => process.pid === processId);
    } catch (error) {
      if (error instanceof SandboxNotFoundError) {
        return false;
      }
      throw error;
    }
  }

  async terminatePreview(
    handle: RuntimeHandle,
    providerProcessRef: string,
    _reason: PreviewStopReason,
  ) {
    try {
      const sandbox = await this.attachSandbox(handle);
      const processId = parseProviderProcessRef(providerProcessRef, "preview");
      await sandbox.commands.kill(processId);
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) {
        throw error;
      }
    }
  }

  async fetchPreview(handle: RuntimeHandle, port: number, request: SandboxPreviewRequest) {
    assertPreviewRequest(port, request);
    try {
      const sandbox = await this.attachSandbox(handle);
      const trafficAccessToken = requireTrafficAccessToken(sandbox);
      const headers = new Headers(request.headers);
      headers.set("e2b-traffic-access-token", trafficAccessToken);

      return fetch(`https://${sandbox.getHost(port)}${request.pathAndQuery}`, {
        headers,
        method: request.method,
        redirect: "manual",
      });
    } catch (error) {
      if (error instanceof SandboxNotFoundError) {
        throw new SandboxUnavailableError();
      }
      throw error;
    }
  }

  async writeFile(handle: RuntimeHandle, path: string, content: string) {
    const sandbox = this.requireSandbox(handle);
    await sandbox.files.write(path, content);
  }

  private requireSandbox(handle: RuntimeHandle) {
    assertRuntimeHandle(handle, this.kind);
    const sandbox = this.sandboxes.get(handle.id);
    if (!sandbox) {
      throw new Error(`E2B runtime handle is not attached: ${handle.id}`);
    }

    return sandbox;
  }

  private async attachSandbox(handle: RuntimeHandle) {
    assertRuntimeHandle(handle, this.kind);
    const cached = this.sandboxes.get(handle.id);
    if (cached) {
      return cached;
    }

    const sandbox = await this.client.connect(handle.id, { apiKey: this.options.apiKey });
    this.sandboxes.set(sandbox.sandboxId, sandbox);
    return sandbox;
  }
}

function toSandboxFileEntryKind(type: FileType | undefined): SandboxFileEntry["kind"] {
  if (type === FileType.DIR) {
    return "directory";
  }
  if (type === FileType.FILE) {
    return "file";
  }
  return "symlink";
}

function mapFilesystemError(error: unknown, path: string): Error {
  if (error instanceof SandboxNotFoundError) {
    return new SandboxUnavailableError();
  }
  if (error instanceof FileNotFoundError) {
    return new SandboxPathNotFoundError(path);
  }
  return error instanceof Error ? error : new Error("Sandbox filesystem request failed");
}

class E2BProcessSession implements SandboxProcessSession {
  constructor(
    private readonly process: E2BCommandHandle,
    private readonly queue: AsyncEventQueue<SandboxProcessEvent>,
  ) {}

  get providerProcessRef() {
    return String(this.process.pid);
  }

  events() {
    return this.queue;
  }

  async terminate(_reason: ProcessTerminationReason) {
    await this.process.kill();
  }

  async write(input: string) {
    await this.process.sendStdin(input);
  }
}

class E2BTerminalSession implements SandboxTerminalSession {
  constructor(
    private readonly process: E2BCommandHandle,
    private readonly pty: E2BPty,
    private readonly queue: AsyncEventQueue<SandboxTerminalEvent>,
  ) {}

  get providerProcessRef() {
    return String(this.process.pid);
  }

  async close(_reason: TerminalCloseReason) {
    await this.process.kill();
  }

  events() {
    return this.queue;
  }

  async resize(size: SandboxTerminalSize) {
    await this.pty.resize(this.process.pid, size);
  }

  async write(input: Uint8Array) {
    await this.pty.sendInput(this.process.pid, input);
  }
}

async function settleProcess(
  process: E2BCommandHandle,
  sandboxLeaseId: string,
  queue: AsyncEventQueue<SandboxProcessEvent>,
) {
  try {
    const result = await process.wait();
    completeProcess(queue, sandboxLeaseId, result);
  } catch (error) {
    if (error instanceof CommandExitError) {
      completeProcess(queue, sandboxLeaseId, error);
      return;
    }

    queue.fail(error);
  }
}

async function settleTerminal(
  process: E2BCommandHandle,
  sandboxLeaseId: string,
  queue: AsyncEventQueue<SandboxTerminalEvent>,
) {
  try {
    const result = await process.wait();
    completeTerminal(queue, sandboxLeaseId, result.exitCode);
  } catch (error) {
    if (error instanceof CommandExitError) {
      completeTerminal(queue, sandboxLeaseId, error.exitCode);
      return;
    }

    queue.fail(error);
  }
}

function completeProcess(
  queue: AsyncEventQueue<SandboxProcessEvent>,
  sandboxLeaseId: string,
  result: Pick<CommandResult, "exitCode">,
) {
  queue.push({
    exitCode: result.exitCode,
    sandboxLeaseId,
    type: "process.completed",
  });
  queue.close();
}

function completeTerminal(
  queue: AsyncEventQueue<SandboxTerminalEvent>,
  sandboxLeaseId: string,
  exitCode: number,
) {
  queue.push({
    exitCode,
    sandboxLeaseId,
    type: "terminal.exited",
  });
  queue.close();
}

type AsyncEventQueueOptions<T> = {
  maxPendingSize: number;
  sizeOf(value: T): number;
};

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly capacityWaiters: Array<() => void> = [];
  private closed = false;
  private failure: unknown = null;
  private readonly pending: T[] = [];
  private pendingSize = 0;
  private producerTail = Promise.resolve();
  private readonly waiters: Array<{
    reject(reason: unknown): void;
    resolve(result: IteratorResult<T>): void;
  }> = [];

  constructor(private readonly options?: AsyncEventQueueOptions<T>) {}

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
    };
  }

  push(value: T) {
    if (this.closed || this.failure) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
    } else {
      this.pending.push(value);
      this.pendingSize += this.options?.sizeOf(value) ?? 0;
    }
  }

  pushWithBackpressure(value: T) {
    const operation = this.producerTail.then(() => this.waitAndPush(value));
    this.producerTail = operation.catch(() => undefined);
    return operation;
  }

  close() {
    if (this.closed || this.failure) {
      return;
    }

    this.closed = true;
    this.releaseCapacityWaiters();
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown) {
    if (this.closed || this.failure) {
      return;
    }

    this.failure = error;
    this.releaseCapacityWaiters();
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  private next(): Promise<IteratorResult<T>> {
    const value = this.pending.shift();
    if (value !== undefined) {
      this.pendingSize -= this.options?.sizeOf(value) ?? 0;
      this.releaseCapacityWaiters();
      return Promise.resolve({ done: false, value });
    }

    if (this.failure) {
      return Promise.reject(this.failure);
    }

    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }

    return new Promise((resolve, reject) => {
      this.waiters.push({ reject, resolve });
    });
  }

  private releaseCapacityWaiters() {
    for (const resolve of this.capacityWaiters.splice(0)) {
      resolve();
    }
  }

  private async waitAndPush(value: T) {
    if (!this.options) {
      this.push(value);
      return;
    }

    const size = this.options.sizeOf(value);
    if (size > this.options.maxPendingSize) {
      throw new Error("Terminal output chunk exceeds queue capacity");
    }

    while (
      !this.closed &&
      !this.failure &&
      this.pending.length > 0 &&
      this.pendingSize + size > this.options.maxPendingSize
    ) {
      await new Promise<void>((resolve) => {
        this.capacityWaiters.push(resolve);
      });
    }
    if (this.failure) {
      throw this.failure;
    }
    if (this.closed) {
      return;
    }
    this.push(value);
  }
}

function terminalEventSize(event: SandboxTerminalEvent) {
  return event.type === "terminal.output" ? event.chunk.byteLength : 0;
}

const boundedGitCommandScript = `
set -uo pipefail
[ -d "$GIT_DIR" ] && [ ! -L "$GIT_DIR" ] || exit 44
[ -f "$GIT_DIR/config" ] && [ ! -L "$GIT_DIR/config" ] || exit 45
[ ! -e "$GIT_DIR/commondir" ] && [ ! -L "$GIT_DIR/commondir" ] || exit 46
[ ! -e "$GIT_DIR/config.worktree" ] && [ ! -L "$GIT_DIR/config.worktree" ] || exit 47
/usr/bin/env -i \
  GIT_ATTR_NOSYSTEM=1 \
  GIT_CONFIG_GLOBAL=/dev/null \
  GIT_CONFIG_NOSYSTEM=1 \
  GIT_DIR=/workspace/.git \
  GIT_LITERAL_PATHSPECS=1 \
  GIT_NO_LAZY_FETCH=1 \
  GIT_OPTIONAL_LOCKS=0 \
  GIT_PAGER=cat \
  GIT_TERMINAL_PROMPT=0 \
  GIT_WORK_TREE=/workspace \
  HOME=/tmp/agent-online-git-home \
  LC_ALL=C \
  PATH=/usr/bin:/bin \
  XDG_CONFIG_HOME=/tmp/agent-online-git-home \
  /usr/bin/git "$@" 2>/dev/null |
  /usr/bin/head -c "$AGENT_ONLINE_OUTPUT_LIMIT"
`.trim();

async function assertSafeGitConfiguration(sandbox: E2BSandbox, timeoutMs: number) {
  const result = await runBoundedGitCommand(
    sandbox,
    changesWorkingDirectory,
    [
      "--no-pager",
      "config",
      "--file",
      "/workspace/.git/config",
      "--no-includes",
      "--name-only",
      "--null",
      "--list",
    ],
    maxGitConfigBytes + 1,
    timeoutMs,
  );
  const bounded = truncateUtf8(result.stdout, maxGitConfigBytes);
  if (result.exitCode === 44) {
    throw new SandboxNotRepositoryError();
  }
  if (result.exitCode !== 0 || bounded.truncated) {
    throw new Error("Git configuration validation failed");
  }

  const keys = bounded.text
    .split("\0")
    .filter(Boolean)
    .map((key) => key.toLowerCase());
  if (keys.some(isUnsafeGitConfigurationKey)) {
    throw new Error("Git configuration is not safe for Changes");
  }
}

function isUnsafeGitConfigurationKey(key: string) {
  return (
    key.startsWith("include.") ||
    key.startsWith("includeif.") ||
    key.startsWith("filter.") ||
    key === "extensions.worktreeconfig" ||
    key === "diff.external" ||
    /^diff\..+\.(command|textconv)$/u.test(key) ||
    key === "core.attributesfile" ||
    key === "core.fsmonitor" ||
    key === "core.hookspath" ||
    key === "core.worktree"
  );
}

async function readGitDiffSection(
  sandbox: E2BSandbox,
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
  allowDifferenceExitCode: boolean,
) {
  const result = await runBoundedGitCommand(
    sandbox,
    cwd,
    args,
    maxGitDiffSectionBytes + 1,
    timeoutMs,
  );
  const bounded = truncateUtf8(result.stdout, maxGitDiffSectionBytes);
  if (result.exitCode === 44) {
    throw new SandboxNotRepositoryError();
  }
  if (
    result.exitCode !== 0 &&
    !(allowDifferenceExitCode && result.exitCode === 1) &&
    !(result.exitCode === 141 && bounded.truncated)
  ) {
    throw new Error("Git diff failed");
  }

  return {
    content: bounded.text,
    truncated: bounded.truncated,
  };
}

async function runBoundedGitCommand(
  sandbox: E2BSandbox,
  cwd: string,
  gitArgs: readonly string[],
  outputLimitBytes: number,
  timeoutMs: number,
) {
  const process = await sandbox.commands.run(
    toShellCommand({
      args: [
        "-i",
        `AGENT_ONLINE_OUTPUT_LIMIT=${outputLimitBytes}`,
        "GIT_DIR=/workspace/.git",
        "/bin/bash",
        "--noprofile",
        "--norc",
        "-c",
        boundedGitCommandScript,
        "agent-online-git",
        ...gitArgs,
      ],
      command: "/usr/bin/env",
    }),
    {
      background: true,
      cwd,
      timeoutMs,
    },
  );

  try {
    return await process.wait();
  } catch (error) {
    if (error instanceof CommandExitError) {
      return error;
    }
    throw error;
  }
}

function createTrackedDiffArgs(change: SandboxChangeEntry, staged: boolean) {
  const paths = change.previousPath === null ? [change.path] : [change.previousPath, change.path];
  return [
    "--no-pager",
    "--literal-pathspecs",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "diff",
    ...(staged ? ["--cached"] : []),
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=all",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--",
    ...paths,
  ];
}

function createUntrackedDiffArgs(path: string) {
  return [
    "--no-pager",
    "--literal-pathspecs",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "diff",
    "--no-index",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--",
    "/dev/null",
    path,
  ];
}

function assertSandboxChange(change: SandboxChangeEntry) {
  if (
    !isSupportedSandboxChangePath(change.path) ||
    (change.previousPath !== null && !isSupportedSandboxChangePath(change.previousPath)) ||
    (!change.stagedKind && !change.unstagedKind)
  ) {
    throw new Error("E2B Changes entry is invalid");
  }
}

function toShellCommand(command: Pick<SandboxCommand, "args" | "command">) {
  return [command.command, ...command.args].map(quoteShellArgument).join(" ");
}

function quoteShellArgument(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function assertRuntimeHandle(handle: RuntimeHandle, kind: "e2b") {
  if (handle.kind !== kind || !handle.id || !handle.sandboxLeaseId) {
    throw new Error("E2BSandboxRuntime received an invalid runtime handle");
  }
}

function parseProviderProcessRef(value: string, kind: "preview" | "process" | "terminal") {
  const processId = Number(value);
  if (!Number.isSafeInteger(processId) || processId < 1) {
    throw new Error(`E2B ${kind} reference is invalid`);
  }
  return processId;
}

function assertPreviewStartInput(input: SandboxPreviewStartInput) {
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

function vitePreviewPreset(contentBasePath: string) {
  return {
    args: [
      "--host",
      "0.0.0.0",
      "--port",
      String(previewPort),
      "--strictPort",
      "--config",
      previewConfigPath,
      "--base",
      contentBasePath,
    ],
    command: "./node_modules/.bin/vite",
    cwd: previewWorkingDirectory,
    env: {
      BROWSER: "none",
      HOST: "0.0.0.0",
      PORT: String(previewPort),
    },
  };
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
    port !== 3000 ||
    (request.method !== "GET" && request.method !== "HEAD") ||
    !request.pathAndQuery.startsWith("/") ||
    request.pathAndQuery.length > 4_096 ||
    request.pathAndQuery.includes("\0") ||
    /[\r\n]/.test(request.pathAndQuery)
  ) {
    throw new Error("E2B Preview request is invalid");
  }
}

function requireTrafficAccessToken(sandbox: E2BSandbox) {
  if (!sandbox.trafficAccessToken) {
    throw new Error("E2B Preview traffic access token is unavailable");
  }
  return sandbox.trafficAccessToken;
}

function toPreviewStartError(stage: string, error: unknown) {
  const sourceName = error instanceof Error ? error.name : "UnknownError";
  const result = new Error("E2B Preview start failed", {
    cause: error,
  });
  result.name = `E2BPreviewStartError.${stage}.${sourceName}`;
  return result;
}

async function writePreviewConfigWithCommand(sandbox: E2BSandbox) {
  const script =
    `umask 077 && printf %s ${btoa(previewConfig)}` + ` | base64 -d > ${previewConfigPath}`;
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

async function waitForPreviewReady(
  sandbox: E2BSandbox,
  processId: number,
  port: number,
  contentBasePath: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  const trafficAccessToken = requireTrafficAccessToken(sandbox);

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
      if (![502, 503, 504].includes(response.status)) {
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
