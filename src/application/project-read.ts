import { listPageSize, type MessagePageQuery, type TimestampCursor } from "../shared/api";
import type {
  AgentRunRecord,
  AgentRunRepository,
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

  async listOwnedProjects(userId: string, cursor?: TimestampCursor) {
    const rows = await this.dependencies.projects.listOwned(userId, cursor);
    const projects = rows.slice(0, listPageSize);
    const leases = await this.dependencies.sandboxLeases.findByProjectIds(
      projects.map((project) => project.id),
    );
    const leasesByProjectId = new Map(leases.map((lease) => [lease.projectId, lease]));

    const last = projects.at(-1);
    return {
      items: projects.map((project) => ({
        lease: leasesByProjectId.get(project.id) ?? null,
        project,
      })),
      nextCursor: rows.length > listPageSize && last ? { at: last.updatedAt, id: last.id } : null,
    };
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

  async listOwnedMessages(projectId: string, userId: string, query: MessagePageQuery = {}) {
    const project = await this.findOwnedProject(projectId, userId);
    if (!project) return null;
    const rows = await this.dependencies.messages.listByProjectId(project.id, query);
    const items = rows.slice(0, listPageSize);
    const nextCursor = rows.length > listPageSize ? (items.at(-1)?.sequence ?? null) : null;
    if (query.after === undefined) items.reverse();
    return { items, nextCursor };
  }

  async listRecentOwnedRuns(projectId: string, userId: string, cursor?: TimestampCursor) {
    const project = await this.findOwnedProject(projectId, userId);
    if (!project) return null;
    const rows = await this.dependencies.agentRuns.listRecentOwnedByProjectId(
      project.id,
      userId,
      cursor,
    );
    const items = rows.slice(0, listPageSize);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > listPageSize && last ? { at: last.createdAt, id: last.id } : null,
    };
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
