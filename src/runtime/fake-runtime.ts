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

class FakeSandboxProcessSession implements SandboxProcessSession {
  private terminationReason: ProcessTerminationReason | null = null;
  private readonly writes: string[] = [];

  constructor(
    private readonly command: SandboxCommand,
    private readonly completionDelayMs: number,
    private readonly sandboxLeaseId: string,
  ) {}

  async *events(): AsyncIterable<SandboxProcessEvent> {
    const processId = `fake-process-${this.command.agentRunId}`;
    const invocation = [this.command.command, ...this.command.args].join(" ");

    yield { processId, sandboxLeaseId: this.sandboxLeaseId, type: "process.started" };

    if (this.completionDelayMs > 0) {
      await delay(this.completionDelayMs);
    }

    if (this.terminationReason) {
      yield { exitCode: 143, sandboxLeaseId: this.sandboxLeaseId, type: "process.completed" };
      return;
    }

    yield {
      chunk: `Started ${invocation} in ${this.command.cwd}`,
      sandboxLeaseId: this.sandboxLeaseId,
      stream: "stdout",
      type: "process.output",
    };
    yield { exitCode: 0, sandboxLeaseId: this.sandboxLeaseId, type: "process.completed" };
  }

  async terminate(reason: ProcessTerminationReason) {
    this.terminationReason = reason;
  }

  async write(input: string) {
    this.writes.push(input);
  }
}

export type FakeSandboxRuntimeOptions = {
  completionDelayMs?: number;
};

export class FakeSandboxRuntime implements SandboxRuntime {
  readonly kind = "fake" as const;

  private readonly handles = new Set<string>();

  constructor(private readonly options: FakeSandboxRuntimeOptions = {}) {}

  async ensureLease(input: EnsureLeaseInput): Promise<RuntimeHandle> {
    const id = `fake-${input.sandboxLeaseId}`;
    this.handles.add(id);
    return { id, kind: this.kind };
  }

  async startProcess(handle: RuntimeHandle, command: SandboxCommand): Promise<SandboxProcessSession> {
    this.assertHandle(handle);
    const sandboxLeaseId = handle.id.replace(/^fake-/, "");
    return new FakeSandboxProcessSession(command, this.options.completionDelayMs ?? 0, sandboxLeaseId);
  }

  async stop(handle: RuntimeHandle, _reason: SandboxStopReason) {
    this.assertHandle(handle);
    this.handles.delete(handle.id);
  }

  private assertHandle(handle: RuntimeHandle) {
    if (!this.handles.has(handle.id)) {
      throw new Error(`Unknown fake runtime handle: ${handle.id}`);
    }
  }
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
