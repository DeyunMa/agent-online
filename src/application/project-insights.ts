import type { AgentRunRecord } from "./ports";
import type { ProjectReadService } from "./project-read";
import type { UserUsageQuery } from "./user-usage";
import type { TimestampCursor } from "../shared/api";

export class InsightsQueryBudgetExceeded extends Error {}

/** Read-only projections. Never return repository records directly to external clients. */
export class ProjectInsightsService {
  constructor(
    private readonly reads: ProjectReadService,
    private readonly usage: UserUsageQuery,
  ) {}

  async listProjects(userId: string, cursor?: TimestampCursor) {
    const page = await this.reads.listOwnedProjects(userId, cursor);
    return {
      items: page.items.map(({ project, lease }) => ({
        id: project.id,
        title: project.title,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        defaultAgentRuntimeId: project.defaultAgentRuntimeId,
        sandboxStatus: lease?.status ?? null,
      })),
      nextCursor: page.nextCursor,
    };
  }

  async listRuns(userId: string, projectId: string, cursor?: TimestampCursor) {
    const page = await this.reads.listRecentOwnedRuns(projectId, userId, cursor);
    return page ? { items: page.items.map(runSummary), nextCursor: page.nextCursor } : null;
  }

  async getRun(userId: string, projectId: string, runId: string) {
    const run = await this.reads.findOwnedRun(projectId, runId, userId);
    return run ? runSummary(run) : null;
  }

  async getUsage(userId: string, projectOffset: number) {
    const summary = await this.usage.getForUser(userId);
    const next = projectOffset + 50;
    return {
      scope: "all_time",
      includesDeletedProjects: true,
      totals: summary.totals,
      agentRuntimes: summary.agentRuntimes,
      projects: summary.projects.slice(projectOffset, next),
      nextProjectOffset: next < summary.projects.length ? next : null,
      projectCount: summary.projects.length,
      limitations: [
        "Not a monetary bill",
        "Includes recorded usage of unfinished, failed and cancelled Runs",
        "Terminal and Preview time is not included",
        "Pages may change while Runs are active",
      ],
    };
  }
}

function runSummary(run: AgentRunRecord) {
  return {
    id: run.id,
    projectId: run.projectId,
    status: run.status,
    agentRuntimeId: run.agentRuntimeId,
    modelId: run.modelId,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    failureCode: run.failureCode,
    usage: {
      inputTokens: run.usage.inputTokens,
      outputTokens: run.usage.outputTokens,
      totalTokens: run.usage.totalTokens,
      modelRequestCount: run.usage.modelRequestCount,
      sandboxDurationMs: run.usage.sandboxDurationMs,
    },
  };
}
