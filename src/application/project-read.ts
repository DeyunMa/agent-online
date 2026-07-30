import type {
  AgentRunRecord,
  AgentRunRepository,
  MessageRecord,
  MessageRepository,
  ProjectRecord,
  ProjectRepository,
  SandboxLeaseRecord,
  SandboxLeaseRepository,
} from "./ports";

export type ProjectReadModel = {
  lease: SandboxLeaseRecord | null;
  project: ProjectRecord;
};

export type ProjectReadServiceDependencies = {
  agentRuns: Pick<
    AgentRunRepository,
    "findActiveOwnedByProjectId" | "findOwnedById" | "listRecentOwnedByProjectId"
  >;
  messages: Pick<MessageRepository, "listByProjectId">;
  projects: Pick<ProjectRepository, "findOwnedById" | "listOwned">;
  sandboxLeases: Pick<SandboxLeaseRepository, "findByProjectId" | "findByProjectIds">;
};

/**
 * Owns authenticated Project reads and cross-repository query composition.
 * HTTP adapters receive product read models instead of individual repositories.
 */
export class ProjectReadService {
  constructor(private readonly dependencies: ProjectReadServiceDependencies) {}

  async listOwnedProjects(userId: string): Promise<ProjectReadModel[]> {
    const projects = await this.dependencies.projects.listOwned(userId);
    const leases = await this.dependencies.sandboxLeases.findByProjectIds(
      projects.map((project) => project.id),
    );
    const leasesByProjectId = new Map(leases.map((lease) => [lease.projectId, lease]));

    return projects.map((project) => ({
      lease: leasesByProjectId.get(project.id) ?? null,
      project,
    }));
  }

  async findOwnedProject(projectId: string, userId: string): Promise<ProjectRecord | null> {
    return this.dependencies.projects.findOwnedById(projectId, userId);
  }

  async findOwnedProjectWithLease(
    projectId: string,
    userId: string,
  ): Promise<ProjectReadModel | null> {
    const project = await this.findOwnedProject(projectId, userId);
    if (!project) {
      return null;
    }

    return {
      lease: await this.dependencies.sandboxLeases.findByProjectId(project.id),
      project,
    };
  }

  async listOwnedMessages(projectId: string, userId: string): Promise<MessageRecord[] | null> {
    const project = await this.findOwnedProject(projectId, userId);
    return project ? this.dependencies.messages.listByProjectId(project.id) : null;
  }

  async listRecentOwnedRuns(projectId: string, userId: string): Promise<AgentRunRecord[] | null> {
    const project = await this.findOwnedProject(projectId, userId);
    return project
      ? this.dependencies.agentRuns.listRecentOwnedByProjectId(project.id, userId)
      : null;
  }

  async findActiveOwnedRun(
    projectId: string,
    userId: string,
  ): Promise<AgentRunRecord | null | undefined> {
    const project = await this.findOwnedProject(projectId, userId);
    return project
      ? this.dependencies.agentRuns.findActiveOwnedByProjectId(project.id, userId)
      : undefined;
  }

  async findOwnedRun(projectId: string, runId: string, userId: string) {
    const run = await this.dependencies.agentRuns.findOwnedById(runId, userId);
    return run?.projectId === projectId ? run : null;
  }
}
