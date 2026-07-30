import type { AgentRuntimeId } from "../agent/contract";
import type { ProjectRecord, ProjectRepository } from "./ports";
import type { StopProjectSandboxResult } from "./project-sandbox";

export type RenameProjectResult =
  | { kind: "not_found" }
  | { kind: "renamed"; project: ProjectRecord };

export type DeleteProjectResult =
  | { kind: "conflict" }
  | { kind: "deleted"; project: ProjectRecord }
  | { kind: "not_found" }
  | { kind: "project_busy" }
  | { kind: "provider_error" };

export type ProjectManagementServiceDependencies = {
  createId(): string;
  defaultAgentRuntimeId: AgentRuntimeId;
  now(): Date;
  projects: ProjectRepository;
  projectSandboxes: {
    stop(projectId: string): Promise<StopProjectSandboxResult>;
  };
};

/**
 * Owns Project metadata mutation and hard-delete orchestration. Callers do not
 * need to coordinate ownership, active sandbox state, or D1 cascade ordering.
 */
export class ProjectManagementService {
  constructor(private readonly dependencies: ProjectManagementServiceDependencies) {}

  create(input: { title: string; userId: string }) {
    return this.dependencies.projects.create({
      defaultAgentRuntimeId: this.dependencies.defaultAgentRuntimeId,
      id: this.dependencies.createId(),
      now: this.dependencies.now().toISOString(),
      title: input.title,
      userId: input.userId,
    });
  }

  async rename(input: {
    projectId: string;
    title: string;
    userId: string;
  }): Promise<RenameProjectResult> {
    const project = await this.dependencies.projects.findOwnedById(input.projectId, input.userId);
    if (!project) {
      return { kind: "not_found" };
    }
    if (project.title === input.title) {
      return { kind: "renamed", project };
    }

    const renamed = await this.dependencies.projects.renameOwned({
      projectId: project.id,
      title: input.title,
      updatedAt: this.dependencies.now().toISOString(),
      userId: input.userId,
    });

    return renamed ? { kind: "renamed", project: renamed } : { kind: "not_found" };
  }

  async delete(input: { projectId: string; userId: string }): Promise<DeleteProjectResult> {
    const project = await this.dependencies.projects.findOwnedById(input.projectId, input.userId);
    if (!project) {
      return { kind: "not_found" };
    }

    const stopped = await this.dependencies.projectSandboxes.stop(project.id);
    const blocked = blockedDeleteResult(stopped);
    if (blocked) {
      return blocked;
    }

    const deleted = await this.dependencies.projects.deleteOwned(project.id, input.userId);
    return deleted ? { kind: "deleted", project } : { kind: "not_found" };
  }
}

function blockedDeleteResult(
  result: StopProjectSandboxResult,
): Exclude<DeleteProjectResult, { kind: "deleted" } | { kind: "not_found" }> | null {
  switch (result.kind) {
    case "already_stopped":
    case "stopped":
      return null;
    case "project_busy":
      return { kind: "project_busy" };
    case "provider_error":
      return { kind: "provider_error" };
    case "conflict":
      return { kind: "conflict" };
  }
}
