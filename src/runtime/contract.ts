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

export type RuntimeEvent =
  | { type: "pi.started"; sandboxLeaseId: string }
  | { type: "pi.completed"; sandboxLeaseId: string }
  | { type: "tool.started"; sandboxLeaseId: string; tool: string };

export type WorkspaceArtifact = {
  archiveKey: string;
  manifestKey: string;
};

export interface SandboxRuntime {
  readonly kind: RuntimeKind;
  checkpoint(handle: RuntimeHandle, reason: "idle" | "manual" | "run-finished"): Promise<WorkspaceArtifact>;
  create(input: CreateLeaseInput): Promise<RuntimeHandle>;
  restore(handle: RuntimeHandle, revision: WorkspaceRevision): Promise<void>;
  startPi(handle: RuntimeHandle, input: { runId: string }): AsyncIterable<RuntimeEvent>;
  stop(handle: RuntimeHandle, reason: "idle" | "manual" | "quota" | "failed"): Promise<void>;
}
