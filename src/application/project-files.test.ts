import { describe, expect, it } from "vitest";

import type { AgentRunRecord, SandboxLeaseRecord } from "./ports";
import { ProjectFilesService } from "./project-files";
import type { RuntimeHandle, SandboxFileEntry } from "../runtime/contract";
import { FakeSandboxRuntime } from "../runtime/fake-runtime";

describe("ProjectFilesService", () => {
  it("lists and reads only the current sandbox workspace", async () => {
    const fixture = await createFixture();
    await fixture.runtime.writeFile(fixture.handle, "/workspace/README.md", "# Demo\n");
    await fixture.runtime.writeFile(fixture.handle, "/workspace/src/index.ts", "export {};\n");
    await fixture.runtime.writeFile(fixture.handle, "/workspace/.git/config", "private");

    const root = await fixture.service.list("project-1", "");
    const source = await fixture.service.list("project-1", "src");
    const file = await fixture.service.read("project-1", "src/index.ts");

    expect(root).toEqual({
      directory: {
        entries: [
          {
            kind: "directory",
            modifiedAt: null,
            name: "src",
            path: "src",
            size: 0,
          },
          {
            kind: "file",
            modifiedAt: null,
            name: "README.md",
            path: "README.md",
            size: 7,
          },
        ],
        path: "",
        truncated: false,
      },
      kind: "ok",
    });
    expect(source).toMatchObject({
      directory: {
        entries: [{ kind: "file", name: "index.ts", path: "src/index.ts" }],
        path: "src",
      },
      kind: "ok",
    });
    expect(file).toEqual({
      file: {
        content: "export {};\n",
        modifiedAt: null,
        name: "index.ts",
        path: "src/index.ts",
        size: 11,
      },
      kind: "ok",
    });
  });

  it("rejects path traversal, private git metadata, and symbolic links", async () => {
    const fixture = await createFixture(new SymlinkFakeSandboxRuntime());

    await expect(fixture.service.read("project-1", "../secret")).resolves.toEqual({
      kind: "unsupported_path",
    });
    await expect(fixture.service.read("project-1", ".git/config")).resolves.toEqual({
      kind: "unsupported_path",
    });
    await expect(fixture.service.read("project-1", "outside")).resolves.toEqual({
      kind: "unsupported_path",
    });
  });

  it("rejects non-text and oversized files before returning their content", async () => {
    const binaryFixture = await createFixture(new BinaryFakeSandboxRuntime());
    await binaryFixture.runtime.writeFile(binaryFixture.handle, "/workspace/data.bin", "x");

    const largeFixture = await createFixture();
    await largeFixture.runtime.writeFile(
      largeFixture.handle,
      "/workspace/large.txt",
      "a".repeat(256 * 1_024 + 1),
    );

    await expect(binaryFixture.service.read("project-1", "data.bin")).resolves.toEqual({
      kind: "unsupported_file",
    });
    await expect(largeFixture.service.read("project-1", "large.txt")).resolves.toEqual({
      kind: "file_too_large",
    });
  });

  it("does not attach files while a Run or Terminal is active or no live Lease exists", async () => {
    const busy = await createFixture(undefined, { activeRun: true });
    const terminalBusy = await createFixture(undefined, {
      terminalActive: true,
    });
    const stopped = await createFixture(undefined, { leaseStatus: "stopped" });
    const requestScoped = await createFixture(new FakeSandboxRuntime());

    await expect(busy.service.list("project-1", "")).resolves.toEqual({
      kind: "project_busy",
    });
    await expect(terminalBusy.service.list("project-1", "")).resolves.toEqual({
      kind: "project_busy",
    });
    await expect(stopped.service.list("project-1", "")).resolves.toEqual({
      kind: "sandbox_unavailable",
    });
    await expect(requestScoped.service.list("project-1", "")).resolves.toEqual({
      kind: "sandbox_unavailable",
    });
  });
});

async function createFixture(
  runtime: FakeSandboxRuntime = new PersistentFakeSandboxRuntime(),
  options: {
    activeRun?: boolean;
    leaseStatus?: SandboxLeaseRecord["status"];
    terminalActive?: boolean;
  } = {},
) {
  const handle = await runtime.ensureLease({
    projectId: "project-1",
    providerRef: "sandbox-1",
    sandboxLeaseId: "lease-1",
  });
  const lease: SandboxLeaseRecord = {
    createdAt: "2026-07-26T00:00:00.000Z",
    id: "lease-1",
    projectId: "project-1",
    providerRef: options.leaseStatus === "stopped" ? null : handle.id,
    runtimeId: "fake",
    status: options.leaseStatus ?? "idle",
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
  const agentRuns = {
    findActiveByProjectId: async () => (options.activeRun ? ({} as AgentRunRecord) : null),
  };
  const sandboxLeases = {
    findByProjectId: async () => lease,
  };

  return {
    handle,
    runtime,
    service: new ProjectFilesService({
      agentRuns,
      getSandboxRuntime: () => runtime,
      now: () => new Date("2026-07-26T00:00:00.000Z"),
      sandboxLeases,
      terminalSessions: {
        findByProjectId: async () => (options.terminalActive ? ({} as never) : null),
      },
      workingDirectory: "/workspace",
    }),
  };
}

class BinaryFakeSandboxRuntime extends FakeSandboxRuntime {
  override readonly filesystemScope = "lease" as const;

  override async readFile(_handle: RuntimeHandle, _path: string) {
    return new Uint8Array([0xff, 0xfe, 0x00]);
  }
}

class SymlinkFakeSandboxRuntime extends FakeSandboxRuntime {
  override readonly filesystemScope = "lease" as const;

  override async listDirectory(handle: RuntimeHandle, path: string): Promise<SandboxFileEntry[]> {
    if (path === "/workspace") {
      return [
        {
          kind: "symlink",
          modifiedAt: null,
          name: "outside",
          size: 0,
        },
      ];
    }
    return super.listDirectory(handle, path);
  }
}

class PersistentFakeSandboxRuntime extends FakeSandboxRuntime {
  override readonly filesystemScope = "lease" as const;
}
