import {
  CommandExitError,
  Sandbox,
  SandboxNotFoundError,
  type CommandHandle,
  type CommandResult,
  type CommandStartOpts,
  type SandboxConnectOpts,
  type SandboxOpts,
} from "e2b";

import type {
  EnsureLeaseInput,
  ProcessTerminationReason,
  RuntimeHandle,
  SandboxCommand,
  SandboxProcessEvent,
  SandboxProcessSession,
  SandboxRuntime,
  SandboxStopReason,
} from "./contract";

type E2BCommandHandle = Pick<CommandHandle, "kill" | "pid" | "sendStdin" | "wait">;

type E2BSandbox = {
  commands: {
    kill(pid: number): Promise<boolean>;
    run(command: string, options: CommandStartOpts & { background: true }): Promise<E2BCommandHandle>;
  };
  files: {
    write(path: string, content: string): Promise<unknown>;
  };
  kill(): Promise<boolean>;
  sandboxId: string;
  setTimeout(timeoutMs: number): Promise<void>;
};

export type E2BSandboxClient = {
  connect(sandboxId: string, options: SandboxConnectOpts): Promise<E2BSandbox>;
  create(templateId: string, options: SandboxOpts): Promise<E2BSandbox>;
};

export type E2BSandboxRuntimeOptions = {
  apiKey: string;
  client?: E2BSandboxClient;
  processTimeoutMs?: number;
  sandboxTimeoutMs?: number;
  templateId: string;
};

const defaultSandboxTimeoutMs = 30 * 60 * 1_000;
const defaultProcessTimeoutMs = 30 * 60 * 1_000;

const defaultClient: E2BSandboxClient = {
  connect: (sandboxId, options) => Sandbox.connect(sandboxId, options),
  create: (templateId, options) => Sandbox.create(templateId, options),
};

export class E2BSandboxRuntime implements SandboxRuntime {
  readonly kind = "e2b" as const;

  private readonly client: E2BSandboxClient;
  private readonly processTimeoutMs: number;
  private readonly sandboxTimeoutMs: number;
  private readonly sandboxes = new Map<string, E2BSandbox>();

  constructor(private readonly options: E2BSandboxRuntimeOptions) {
    if (!options.apiKey || !options.templateId) {
      throw new Error("E2BSandboxRuntime requires apiKey and templateId");
    }

    this.client = options.client ?? defaultClient;
    this.processTimeoutMs = requirePositiveTimeout(options.processTimeoutMs ?? defaultProcessTimeoutMs);
    this.sandboxTimeoutMs = requirePositiveTimeout(options.sandboxTimeoutMs ?? defaultSandboxTimeoutMs);
  }

  async ensureLease(input: EnsureLeaseInput): Promise<RuntimeHandle> {
    if (input.providerRef) {
      try {
        const existing = await this.client.connect(input.providerRef, { apiKey: this.options.apiKey });
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
      timeoutMs: this.sandboxTimeoutMs,
    });
    this.sandboxes.set(sandbox.sandboxId, sandbox);
    return { id: sandbox.sandboxId, kind: this.kind, sandboxLeaseId: input.sandboxLeaseId };
  }

  async startProcess(handle: RuntimeHandle, command: SandboxCommand): Promise<SandboxProcessSession> {
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
    const processId = Number(providerProcessRef);
    if (!Number.isSafeInteger(processId) || processId < 1) {
      throw new Error("E2B process reference is invalid");
    }

    const killed = await sandbox.commands.kill(processId);
    if (!killed) {
      throw new Error(`E2B process was not found: ${providerProcessRef}`);
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

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private closed = false;
  private failure: unknown = null;
  private readonly pending: T[] = [];
  private readonly waiters: Array<{
    reject(reason: unknown): void;
    resolve(result: IteratorResult<T>): void;
  }> = [];

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
    }
  }

  close() {
    if (this.closed || this.failure) {
      return;
    }

    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown) {
    if (this.closed || this.failure) {
      return;
    }

    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  private next(): Promise<IteratorResult<T>> {
    const value = this.pending.shift();
    if (value !== undefined) {
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
}

function toShellCommand(command: SandboxCommand) {
  return [command.command, ...command.args].map(quoteShellArgument).join(" ");
}

function quoteShellArgument(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function assertRuntimeHandle(handle: RuntimeHandle, kind: "e2b") {
  if (handle.kind !== kind || !handle.id || !handle.sandboxLeaseId) {
    throw new Error("E2BSandboxRuntime received an invalid runtime handle");
  }
}

function requirePositiveTimeout(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("E2BSandboxRuntime timeouts must be positive safe integers");
  }

  return value;
}
