import type {
  AgentRunRepository,
  SandboxLeaseRecord,
  SandboxLeaseRepository,
  TerminalSessionRepository,
} from "./ports";
import type {
  RuntimeHandle,
  RuntimeKind,
  SandboxChangeDiff,
  SandboxChangeEntry,
  SandboxChangesRuntime,
} from "../runtime/contract";
import {
  isSupportedSandboxChangePath,
  SandboxNotRepositoryError,
  SandboxUnavailableError,
} from "../runtime/contract";

export type ProjectChangesSnapshot = {
  entries: SandboxChangeEntry[];
  repository: boolean;
  truncated: boolean;
  unsupportedEntries: boolean;
};

export type ProjectChangeDetails = SandboxChangeDiff & {
  change: SandboxChangeEntry;
};

export type ProjectChangesFailure =
  | { kind: "path_not_found" }
  | { kind: "project_busy" }
  | { kind: "provider_error" }
  | { kind: "runtime_mismatch" }
  | { kind: "sandbox_unavailable" }
  | { kind: "unsupported_path" };

export type ListProjectChangesResult =
  | { changes: ProjectChangesSnapshot; kind: "ok" }
  | ProjectChangesFailure;

export type ReadProjectChangeResult =
  | { details: ProjectChangeDetails; kind: "ok" }
  | ProjectChangesFailure;

export type ProjectChangesServiceOptions = {
  agentRuns: Pick<AgentRunRepository, "findActiveByProjectId">;
  getSandboxRuntime(
    id: RuntimeKind,
  ): SandboxChangesRuntime | null;
  sandboxLeases: Pick<SandboxLeaseRepository, "findByProjectId">;
  terminalSessions: Pick<
    TerminalSessionRepository,
    "findByProjectId"
  >;
};

export class ProjectChangesService {
  constructor(private readonly options: ProjectChangesServiceOptions) {}

  async list(projectId: string): Promise<ListProjectChangesResult> {
    const access = await this.getAccess(projectId);
    if (access.kind !== "ok") {
      return access;
    }

    try {
      const changes = await access.runtime.listChanges(
        access.handle,
      );
      return {
        changes: {
          ...changes,
          repository: true,
        },
        kind: "ok",
      };
    } catch (error) {
      if (error instanceof SandboxNotRepositoryError) {
        return {
          changes: {
            entries: [],
            repository: false,
            truncated: false,
            unsupportedEntries: false,
          },
          kind: "ok",
        };
      }
      return toFailure(error);
    }
  }

  async read(
    projectId: string,
    rawPath: string | undefined,
  ): Promise<ReadProjectChangeResult> {
    if (
      rawPath === undefined ||
      !isSupportedSandboxChangePath(rawPath)
    ) {
      return { kind: "unsupported_path" };
    }

    const access = await this.getAccess(projectId);
    if (access.kind !== "ok") {
      return access;
    }

    try {
      const snapshot = await access.runtime.listChanges(
        access.handle,
      );
      const change = snapshot.entries.find(
        (entry) => entry.path === rawPath,
      );
      if (!change) {
        return { kind: "path_not_found" };
      }

      const diff = await access.runtime.readChangeDiff(
        access.handle,
        change,
      );
      return {
        details: {
          change,
          ...diff,
        },
        kind: "ok",
      };
    } catch (error) {
      if (error instanceof SandboxNotRepositoryError) {
        return { kind: "path_not_found" };
      }
      return toFailure(error);
    }
  }

  private async getAccess(
    projectId: string,
  ): Promise<
    | {
        handle: RuntimeHandle;
        kind: "ok";
        runtime: SandboxChangesRuntime;
      }
    | Extract<
        ProjectChangesFailure,
        {
          kind:
            | "project_busy"
            | "provider_error"
            | "runtime_mismatch"
            | "sandbox_unavailable";
        }
      >
  > {
    if (await this.options.agentRuns.findActiveByProjectId(projectId)) {
      return { kind: "project_busy" };
    }
    if (await this.options.terminalSessions.findByProjectId(projectId)) {
      return { kind: "project_busy" };
    }

    const lease = await this.options.sandboxLeases.findByProjectId(
      projectId,
    );
    if (!lease?.providerRef) {
      return { kind: "sandbox_unavailable" };
    }
    if (lease.status === "busy" || lease.status === "starting") {
      return { kind: "project_busy" };
    }
    if (lease.status !== "idle" && lease.status !== "ready") {
      return { kind: "sandbox_unavailable" };
    }

    try {
      const runtime = this.options.getSandboxRuntime(lease.runtimeId);
      if (!runtime || runtime.kind !== lease.runtimeId) {
        return { kind: "runtime_mismatch" };
      }
      return {
        handle: toRuntimeHandle(lease),
        kind: "ok",
        runtime,
      };
    } catch {
      return { kind: "provider_error" };
    }
  }
}

function toRuntimeHandle(lease: SandboxLeaseRecord): RuntimeHandle {
  if (!lease.providerRef) {
    throw new SandboxUnavailableError();
  }
  return {
    id: lease.providerRef,
    kind: lease.runtimeId,
    sandboxLeaseId: lease.id,
  };
}

function toFailure(error: unknown): ProjectChangesFailure {
  if (error instanceof SandboxUnavailableError) {
    return { kind: "sandbox_unavailable" };
  }
  return { kind: "provider_error" };
}
