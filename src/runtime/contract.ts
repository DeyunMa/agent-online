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
export type SandboxFilesystemScope = "lease" | "runtime-instance";

export type SandboxFileEntry = {
  kind: "directory" | "file" | "symlink";
  modifiedAt: string | null;
  name: string;
  size: number;
};

export class SandboxPathNotFoundError extends Error {
  constructor(path: string) {
    super(`Sandbox path was not found: ${path}`);
    this.name = "SandboxPathNotFoundError";
  }
}

export class SandboxUnavailableError extends Error {
  constructor(message = "Sandbox is unavailable") {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

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

export interface SandboxLifecycleRuntime {
  readonly kind: RuntimeKind;
  ensureLease(input: EnsureLeaseInput): Promise<RuntimeHandle>;
  stop(handle: RuntimeHandle, reason: SandboxStopReason): Promise<void>;
}

export interface SandboxFilesystemRuntime {
  readonly filesystemScope: SandboxFilesystemScope;
  readonly kind: RuntimeKind;
  listDirectory(handle: RuntimeHandle, path: string): Promise<SandboxFileEntry[]>;
  readFile(handle: RuntimeHandle, path: string): Promise<Uint8Array>;
  writeFile(handle: RuntimeHandle, path: string, content: string): Promise<void>;
}

export interface SandboxProcessRuntime {
  readonly kind: RuntimeKind;
  startProcess(handle: RuntimeHandle, command: SandboxCommand): Promise<SandboxProcessSession>;
  terminateProcess(
    handle: RuntimeHandle,
    providerProcessRef: string,
    reason: ProcessTerminationReason,
  ): Promise<void>;
}

export interface SandboxRuntime
  extends SandboxFilesystemRuntime,
    SandboxLifecycleRuntime,
    SandboxProcessRuntime {}
