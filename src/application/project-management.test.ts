import { describe, expect, it, vi } from "vitest";

import type { ProjectRecord, ProjectRepository, SandboxLeaseRecord } from "./ports";
import { ProjectManagementService } from "./project-management";
import type { StopProjectSandboxResult } from "./project-sandbox";

const project: ProjectRecord = {
  createdAt: "2026-07-28T00:00:00.000Z",
  defaultAgentRuntimeId: "pi",
  id: "project-1",
  title: "Original",
  updatedAt: "2026-07-28T00:00:00.000Z",
  userId: "user-1",
};
const lease: SandboxLeaseRecord = {
  createdAt: project.createdAt,
  id: "lease-1",
  projectId: project.id,
  providerRef: null,
  runtimeId: "fake",
  status: "stopped",
  updatedAt: project.updatedAt,
};

describe("ProjectManagementService", () => {
  it("renames only an owned Project and touches its update time", async () => {
    const fixture = createFixture();

    const result = await fixture.service.rename({
      projectId: project.id,
      title: "Renamed",
      userId: project.userId,
    });

    expect(result).toEqual({
      kind: "renamed",
      project: {
        ...project,
        title: "Renamed",
        updatedAt: "2026-07-28T01:00:00.000Z",
      },
    });
    expect(fixture.projects.renameOwned).toHaveBeenCalledWith({
      projectId: project.id,
      title: "Renamed",
      updatedAt: "2026-07-28T01:00:00.000Z",
      userId: project.userId,
    });
  });

  it("does not touch an unchanged title", async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.rename({
        projectId: project.id,
        title: project.title,
        userId: project.userId,
      }),
    ).resolves.toEqual({ kind: "renamed", project });
    expect(fixture.projects.renameOwned).not.toHaveBeenCalled();
  });

  it("stops an idle sandbox before hard-deleting the Project", async () => {
    const fixture = createFixture({ stopResult: { kind: "stopped", lease } });

    await expect(
      fixture.service.delete({ projectId: project.id, userId: project.userId }),
    ).resolves.toEqual({ kind: "deleted", project });
    expect(fixture.projectSandboxes.stop).toHaveBeenCalledWith(project.id);
    expect(fixture.projects.deleteOwned).toHaveBeenCalledWith(project.id, project.userId);
  });

  it.each([
    ["project_busy", { kind: "project_busy" }],
    ["provider_error", { kind: "provider_error", lease }],
    ["conflict", { kind: "conflict" }],
  ] as const)("does not delete when sandbox shutdown returns %s", async (kind, stopResult) => {
    const fixture = createFixture({
      stopResult: stopResult as StopProjectSandboxResult,
    });

    await expect(
      fixture.service.delete({ projectId: project.id, userId: project.userId }),
    ).resolves.toEqual({ kind });
    expect(fixture.projects.deleteOwned).not.toHaveBeenCalled();
  });

  it("does not reveal or mutate a Project owned by another user", async () => {
    const fixture = createFixture({ owned: false });

    await expect(
      fixture.service.delete({ projectId: project.id, userId: "other-user" }),
    ).resolves.toEqual({ kind: "not_found" });
    expect(fixture.projectSandboxes.stop).not.toHaveBeenCalled();
    expect(fixture.projects.deleteOwned).not.toHaveBeenCalled();
  });
});

function createFixture(options: { owned?: boolean; stopResult?: StopProjectSandboxResult } = {}) {
  let current = project;
  const projects = {
    create: vi.fn(),
    deleteOwned: vi.fn(async () => true),
    findOwnedById: vi.fn(async (_projectId: string, userId: string) =>
      options.owned === false || userId !== project.userId ? null : current,
    ),
    listOwned: vi.fn(),
    renameOwned: vi.fn(
      async (input: Parameters<ProjectRepository["renameOwned"]>[0]): Promise<ProjectRecord> => {
        current = {
          ...current,
          title: input.title,
          updatedAt: input.updatedAt,
        };
        return current;
      },
    ),
  } satisfies ProjectRepository;
  const projectSandboxes = {
    stop: vi.fn(
      async (): Promise<StopProjectSandboxResult> =>
        options.stopResult ?? { kind: "already_stopped", lease: null },
    ),
  };

  return {
    projectSandboxes,
    projects,
    service: new ProjectManagementService({
      createId: () => "project_new",
      defaultAgentRuntimeId: "pi",
      now: () => new Date("2026-07-28T01:00:00.000Z"),
      projects,
      projectSandboxes,
    }),
  };
}
