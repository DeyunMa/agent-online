export type RuntimeKind = "fake" | "e2b" | "cloudflare-container";

export type RuntimeHandle = {
  id: string;
  kind: RuntimeKind;
  sandboxLeaseId: string;
};

export type EnsureLeaseInput = {
  providerRef: string | null;
  projectId: string;
  sandboxLeaseId: string;
};

export type SandboxCommand = {
  agentRunId: string;
  args: readonly string[];
  command: string;
  cwd: string;
  env?: Readonly<Record<string, string>>;
};

export type ProcessTerminationReason = "completed" | "cancelled" | "timed_out" | "failed";
export type SandboxStopReason = "idle" | "manual" | "failed";

export type SandboxProcessEvent =
  | { processId: string; sandboxLeaseId: string; type: "process.started" }
  | { chunk: string; sandboxLeaseId: string; stream: "stderr" | "stdout"; type: "process.output" }
  | { exitCode: number; sandboxLeaseId: string; type: "process.completed" };

export interface SandboxProcessSession {
  readonly providerProcessRef: string;
  events(): AsyncIterable<SandboxProcessEvent>;
  terminate(reason: ProcessTerminationReason): Promise<void>;
  write(input: string): Promise<void>;
}

export interface SandboxRuntime {
  readonly kind: RuntimeKind;
  ensureLease(input: EnsureLeaseInput): Promise<RuntimeHandle>;
  startProcess(handle: RuntimeHandle, command: SandboxCommand): Promise<SandboxProcessSession>;
  terminateProcess(
    handle: RuntimeHandle,
    providerProcessRef: string,
    reason: ProcessTerminationReason,
  ): Promise<void>;
  stop(handle: RuntimeHandle, reason: SandboxStopReason): Promise<void>;
  writeFile(handle: RuntimeHandle, path: string, content: string): Promise<void>;
}
