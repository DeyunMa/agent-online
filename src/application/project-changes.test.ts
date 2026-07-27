import { describe, expect, it } from "vitest";

import type { AgentRunRecord, SandboxLeaseRecord } from "./ports";
import { ProjectChangesService } from "./project-changes";
import type { RuntimeHandle, SandboxChangeEntry, SandboxChangesRuntime } from "../runtime/contract";
import { SandboxNotRepositoryError, SandboxUnavailableError } from "../runtime/contract";

describe("ProjectChangesService", () => {
  it("lists current changes and reads only a status-derived path", async () => {
    const fixture = createFixture();

    await expect(fixture.service.list("project-1")).resolves.toEqual({
      changes: {
        entries: [fixture.change],
        repository: true,
        truncated: false,
        unsupportedEntries: false,
      },
      kind: "ok",
    });
    await expect(fixture.service.read("project-1", "src/index.ts")).resolves.toEqual({
      details: {
        change: fixture.change,
        staged: null,
        unstaged: {
          content: "@@ -1 +1 @@\n-old\n+new\n",
          truncated: false,
        },
      },
      kind: "ok",
    });
    expect(fixture.runtime.readPaths).toEqual(["src/index.ts"]);
  });

  it("rejects private, traversing, and stale paths before diff execution", async () => {
    const fixture = createFixture();

    await expect(fixture.service.read("project-1", "../secret")).resolves.toEqual({
      kind: "unsupported_path",
    });
    await expect(fixture.service.read("project-1", ".git/config")).resolves.toEqual({
      kind: "unsupported_path",
    });
    await expect(fixture.service.read("project-1", "stale.ts")).resolves.toEqual({
      kind: "path_not_found",
    });
    expect(fixture.runtime.readPaths).toEqual([]);
  });

  it("treats a non-repository workspace as a normal empty state", async () => {
    const fixture = createFixture({ repository: false });

    await expect(fixture.service.list("project-1")).resolves.toEqual({
      changes: {
        entries: [],
        repository: false,
        truncated: false,
        unsupportedEntries: false,
      },
      kind: "ok",
    });
  });

  it("does not attach while a Run or Terminal is active or without a live Lease", async () => {
    const activeRun = createFixture({ activeRun: true });
    const activeTerminal = createFixture({ terminalActive: true });
    const stopped = createFixture({ leaseStatus: "stopped" });

    await expect(activeRun.service.list("project-1")).resolves.toEqual({
      kind: "project_busy",
    });
    await expect(activeTerminal.service.list("project-1")).resolves.toEqual({
      kind: "project_busy",
    });
    await expect(stopped.service.list("project-1")).resolves.toEqual({
      kind: "sandbox_unavailable",
    });
  });

  it("maps expired sandboxes and missing runtime capabilities without leaking provider details", async () => {
    const expired = createFixture({ unavailable: true });
    const missingRuntime = createFixture({ runtimeAvailable: false });

    await expect(expired.service.list("project-1")).resolves.toEqual({
      kind: "sandbox_unavailable",
    });
    await expect(missingRuntime.service.list("project-1")).resolves.toEqual({
      kind: "runtime_mismatch",
    });
  });
});

function createFixture(
  options: {
    activeRun?: boolean;
    leaseStatus?: SandboxLeaseRecord["status"];
    repository?: boolean;
    runtimeAvailable?: boolean;
    terminalActive?: boolean;
    unavailable?: boolean;
  } = {},
) {
  const change: SandboxChangeEntry = {
    path: "src/index.ts",
    previousPath: null,
    stagedKind: null,
    unstagedKind: "modified",
  };
  const runtime = new ChangesRuntime(change, options);
  const lease: SandboxLeaseRecord = {
    createdAt: "2026-07-26T00:00:00.000Z",
    id: "lease-1",
    projectId: "project-1",
    providerRef: options.leaseStatus === "stopped" ? null : "sandbox-private",
    runtimeId: "e2b",
    status: options.leaseStatus ?? "idle",
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
  const service = new ProjectChangesService({
    agentRuns: {
      findActiveByProjectId: async () => (options.activeRun ? ({} as AgentRunRecord) : null),
    },
    getSandboxRuntime: () => (options.runtimeAvailable === false ? null : runtime),
    sandboxLeases: {
      findByProjectId: async () => lease,
    },
    terminalSessions: {
      findByProjectId: async () => (options.terminalActive ? ({} as never) : null),
    },
  });

  return { change, runtime, service };
}

class ChangesRuntime implements SandboxChangesRuntime {
  readonly kind = "e2b" as const;
  readonly readPaths: string[] = [];

  constructor(
    private readonly change: SandboxChangeEntry,
    private readonly options: {
      repository?: boolean;
      unavailable?: boolean;
    },
  ) {}

  async listChanges(_handle: RuntimeHandle) {
    if (this.options.unavailable) {
      throw new SandboxUnavailableError("private-provider-detail");
    }
    if (this.options.repository === false) {
      throw new SandboxNotRepositoryError();
    }
    return {
      entries: [this.change],
      truncated: false,
      unsupportedEntries: false,
    };
  }

  async readChangeDiff(_handle: RuntimeHandle, change: SandboxChangeEntry) {
    this.readPaths.push(change.path);
    return {
      staged: null,
      unstaged: {
        content: "@@ -1 +1 @@\n-old\n+new\n",
        truncated: false,
      },
    };
  }
}
