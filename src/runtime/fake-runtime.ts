import type {
  CreateLeaseInput,
  RuntimeEvent,
  RuntimeHandle,
  SandboxRuntime,
  WorkspaceArtifact,
  WorkspaceRevision,
} from "./contract";

export class FakeSandboxRuntime implements SandboxRuntime {
  readonly kind = "fake" as const;

  private readonly handles = new Set<string>();

  async create(input: CreateLeaseInput): Promise<RuntimeHandle> {
    const id = `fake-${input.sandboxLeaseId}`;
    this.handles.add(id);
    return { id, kind: this.kind };
  }

  async restore(handle: RuntimeHandle, _revision: WorkspaceRevision) {
    this.assertHandle(handle);
  }

  async *startPi(handle: RuntimeHandle, _input: { runId: string }): AsyncIterable<RuntimeEvent> {
    this.assertHandle(handle);
    const sandboxLeaseId = handle.id.replace(/^fake-/, "");
    yield { sandboxLeaseId, type: "pi.started" };
    yield { sandboxLeaseId, tool: "read", type: "tool.started" };
    yield { sandboxLeaseId, type: "pi.completed" };
  }

  async checkpoint(handle: RuntimeHandle, _reason: "idle" | "manual" | "run-finished"): Promise<WorkspaceArtifact> {
    this.assertHandle(handle);
    return {
      archiveKey: `fake/${handle.id}/workspace.tar.zst`,
      manifestKey: `fake/${handle.id}/manifest.json`,
    };
  }

  async stop(handle: RuntimeHandle, _reason: "idle" | "manual" | "quota" | "failed") {
    this.assertHandle(handle);
    this.handles.delete(handle.id);
  }

  private assertHandle(handle: RuntimeHandle) {
    if (!this.handles.has(handle.id)) {
      throw new Error(`Unknown fake runtime handle: ${handle.id}`);
    }
  }
}
