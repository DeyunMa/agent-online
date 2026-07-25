export type RuntimeKind = "fake" | "e2b" | "cloudflare-container";

export type RuntimeHandle = {
  id: string;
  kind: RuntimeKind;
};

export type CreateLeaseInput = {
  projectId: string;
  sandboxLeaseId: string;
};

export type WorkspaceRevision = {
  id: string;
  projectId: string;
};

export type SandboxCommand = {
  args: readonly string[];
  command: string;
  cwd: string;
  runId: string;
};

export type SandboxProcessEvent =
  | { processId: string; sandboxLeaseId: string; type: "process.started" }
  | { chunk: string; sandboxLeaseId: string; stream: "stderr" | "stdout"; type: "process.output" }
  | { exitCode: number; sandboxLeaseId: string; type: "process.completed" };

export type WorkspaceArtifact = {
  archiveKey: string;
  manifestKey: string;
};

export interface SandboxRuntime {
  readonly kind: RuntimeKind;
  checkpoint(handle: RuntimeHandle, reason: "idle" | "manual" | "run-finished"): Promise<WorkspaceArtifact>;
  create(input: CreateLeaseInput): Promise<RuntimeHandle>;
  execute(handle: RuntimeHandle, command: SandboxCommand): AsyncIterable<SandboxProcessEvent>;
  restore(handle: RuntimeHandle, revision: WorkspaceRevision): Promise<void>;
  stop(handle: RuntimeHandle, reason: "idle" | "manual" | "quota" | "failed"): Promise<void>;
}
