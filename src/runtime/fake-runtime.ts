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

  get providerProcessRef() {
    return `fake-process-${this.command.agentRunId}`;
  }

  async *events(): AsyncIterable<SandboxProcessEvent> {
    const invocation = [this.command.command, ...this.command.args].join(" ");

    yield {
      processId: this.providerProcessRef,
      sandboxLeaseId: this.sandboxLeaseId,
      type: "process.started",
    };

    if (this.completionDelayMs > 0) {
      await delay(this.completionDelayMs);
    }

    if (this.terminationReason) {
      yield { exitCode: 143, sandboxLeaseId: this.sandboxLeaseId, type: "process.completed" };
      return;
    }

    yield {
      chunk: isPiRpcCommand(this.command)
        ? [
            JSON.stringify({ command: "prompt", success: true, type: "response" }),
            JSON.stringify({ type: "agent_start" }),
            JSON.stringify({ type: "agent_settled" }),
            "",
          ].join("\n")
        : `Started ${invocation} in ${this.command.cwd}`,
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
  private readonly files = new Map<string, string>();
  private readonly processes = new Map<string, FakeSandboxProcessSession>();

  constructor(private readonly options: FakeSandboxRuntimeOptions = {}) {}

  async ensureLease(input: EnsureLeaseInput): Promise<RuntimeHandle> {
    const id = input.providerRef ?? `fake-${input.sandboxLeaseId}`;
    this.handles.add(id);
    return { id, kind: this.kind, sandboxLeaseId: input.sandboxLeaseId };
  }

  async startProcess(handle: RuntimeHandle, command: SandboxCommand): Promise<SandboxProcessSession> {
    this.assertHandle(handle);
    const session = new FakeSandboxProcessSession(
      command,
      this.options.completionDelayMs ?? 0,
      handle.sandboxLeaseId,
    );
    this.processes.set(session.providerProcessRef, session);
    return session;
  }

  async terminateProcess(
    handle: RuntimeHandle,
    providerProcessRef: string,
    reason: ProcessTerminationReason,
  ) {
    this.assertHandle(handle);
    const session = this.processes.get(providerProcessRef);
    if (!session) {
      throw new Error(`Unknown fake process: ${providerProcessRef}`);
    }
    await session.terminate(reason);
  }

  async stop(handle: RuntimeHandle, _reason: SandboxStopReason) {
    assertRuntimeHandle(handle, this.kind);
    this.handles.delete(handle.id);
  }

  async writeFile(handle: RuntimeHandle, path: string, content: string) {
    this.assertHandle(handle);
    this.files.set(`${handle.id}:${path}`, content);
  }

  private assertHandle(handle: RuntimeHandle) {
    if (!this.handles.has(handle.id)) {
      throw new Error(`Unknown fake runtime handle: ${handle.id}`);
    }
  }
}

function assertRuntimeHandle(handle: RuntimeHandle, kind: "fake") {
  if (handle.kind !== kind) {
    throw new Error(
      `Runtime handle kind ${handle.kind} does not match runtime ${kind}`,
    );
  }
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function isPiRpcCommand(command: SandboxCommand) {
  const modeIndex = command.args.indexOf("--mode");
  return command.command === "pi" && modeIndex >= 0 && command.args[modeIndex + 1] === "rpc";
}
