import { describe, expect, it, vi } from "vitest";

import type { AgentRunRecord, ProjectRecord, SandboxLeaseRecord } from "./ports";
import { ProjectReadService, type ProjectReadServiceDependencies } from "./project-read";

const project = {
  createdAt: "2026-07-30T00:00:00.000Z",
  defaultAgentRuntimeId: "pi",
  id: "project-1",
  title: "Project 1",
  updatedAt: "2026-07-30T00:00:00.000Z",
  userId: "user-1",
} satisfies ProjectRecord;

const secondProject = {
  ...project,
  id: "project-2",
  title: "Project 2",
} satisfies ProjectRecord;

const lease = {
  createdAt: "2026-07-30T00:00:00.000Z",
  id: "lease-1",
  projectId: project.id,
  providerRef: null,
  runtimeId: "e2b",
  status: "stopped",
  updatedAt: "2026-07-30T00:00:00.000Z",
} satisfies SandboxLeaseRecord;

describe("ProjectReadService", () => {
  it("loads all Project leases through one batch repository call", async () => {
    const dependencies = createDependencies();
    const service = new ProjectReadService(dependencies);

    const projects = await service.listOwnedProjects(project.userId);

    expect(dependencies.sandboxLeases.findByProjectIds).toHaveBeenCalledOnce();
    expect(dependencies.sandboxLeases.findByProjectIds).toHaveBeenCalledWith([
      project.id,
      secondProject.id,
    ]);
    expect(projects).toEqual([
      { lease, project },
      { lease: null, project: secondProject },
    ]);
  });

  it("does not read messages or Runs for a Project the user does not own", async () => {
    const dependencies = createDependencies({ projectOwned: false });
    const service = new ProjectReadService(dependencies);

    await expect(service.listOwnedMessages(project.id, "other-user")).resolves.toBeNull();
    await expect(service.listRecentOwnedRuns(project.id, "other-user")).resolves.toBeNull();
    await expect(service.findActiveOwnedRun(project.id, "other-user")).resolves.toBeUndefined();
    expect(dependencies.messages.listByProjectId).not.toHaveBeenCalled();
    expect(dependencies.agentRuns.listRecentOwnedByProjectId).not.toHaveBeenCalled();
    expect(dependencies.agentRuns.findActiveOwnedByProjectId).not.toHaveBeenCalled();
  });
});

function createDependencies(options: { projectOwned?: boolean } = {}) {
  const run = {
    id: "run-1",
    projectId: project.id,
  } as AgentRunRecord;

  return {
    agentRuns: {
      findActiveOwnedByProjectId: vi.fn(async () => run),
      findOwnedById: vi.fn(async () => run),
      listRecentOwnedByProjectId: vi.fn(async () => [run]),
    },
    messages: {
      listByProjectId: vi.fn(async () => []),
    },
    projects: {
      findOwnedById: vi.fn(async () => (options.projectOwned === false ? null : project)),
      listOwned: vi.fn(async () => [project, secondProject]),
    },
    sandboxLeases: {
      findByProjectId: vi.fn(async () => lease),
      findByProjectIds: vi.fn(async () => [lease]),
    },
  } satisfies ProjectReadServiceDependencies;
}
