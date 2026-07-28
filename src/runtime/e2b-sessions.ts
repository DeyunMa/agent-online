import { CommandExitError, type CommandResult } from "e2b";

import type {
  ProcessTerminationReason,
  RuntimeHandle,
  SandboxCommand,
  SandboxProcessEvent,
  SandboxProcessSession,
  SandboxTerminalEvent,
  SandboxTerminalSession,
  SandboxTerminalSize,
  TerminalCloseReason,
} from "./contract";
import { toShellCommand } from "./e2b-shell";
import type { E2BCommandHandle, E2BPty, E2BSandbox } from "./e2b-types";

export type E2BTerminalSessionOptions = {
  outputLimitBytes: number;
  pendingOutputBytes: number;
  timeoutMs: number;
};

export async function startE2BProcessSession(
  sandbox: E2BSandbox,
  handle: RuntimeHandle,
  command: SandboxCommand,
  timeoutMs: number,
): Promise<SandboxProcessSession> {
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
    ...(command.env ? { envs: { ...command.env } } : {}),
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
    timeoutMs,
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

export async function startE2BTerminalSession(
  sandbox: E2BSandbox,
  handle: RuntimeHandle,
  input: SandboxTerminalSize & { cwd: string },
  options: E2BTerminalSessionOptions,
): Promise<SandboxTerminalSession> {
  const queue = new AsyncEventQueue<SandboxTerminalEvent>({
    maxPendingSize: options.pendingOutputBytes,
    sizeOf: terminalEventSize,
  });
  let outputBytes = 0;
  const process = await sandbox.pty.create({
    cols: input.cols,
    cwd: input.cwd,
    onData: async (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > options.outputLimitBytes) {
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
    timeoutMs: options.timeoutMs,
  });

  void settleTerminal(process, handle.sandboxLeaseId, queue);
  return new E2BTerminalSession(process, sandbox.pty, queue);
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
