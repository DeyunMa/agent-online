import type { AgentRuntimeId } from "../agent/contract";
import type { AgentRunUsage } from "./ports";

export type UsageMetrics = AgentRunUsage & {
  runCount: number;
};

export type ProjectUsageSummary = {
  projectDeleted: boolean;
  projectId: string;
  projectTitle: string;
  usage: UsageMetrics;
};

export type AgentRuntimeUsageSummary = {
  agentRuntimeId: AgentRuntimeId;
  usage: UsageMetrics;
};

export type UserUsageSummary = {
  agentRuntimes: AgentRuntimeUsageSummary[];
  projects: ProjectUsageSummary[];
  totals: UsageMetrics;
};

export interface UserUsageRepository {
  summarizeByUser(userId: string): Promise<UserUsageSummary>;
}

export interface UserUsageQuery {
  getForUser(userId: string): Promise<UserUsageSummary>;
}

export class UserUsageService implements UserUsageQuery {
  constructor(private readonly repository: UserUsageRepository) {}

  getForUser(userId: string) {
    if (!userId) {
      throw new Error("User ID is required to read usage");
    }

    return this.repository.summarizeByUser(userId);
  }
}
