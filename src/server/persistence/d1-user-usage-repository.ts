import type { UserUsageRepository, UserUsageSummary } from "../../application/user-usage";
import {
  type AgentRuntimeUsageRow,
  type ProjectUsageRow,
  type UsageAggregateRow,
  requireBatchRow,
  toAgentRuntimeUsageSummary,
  toProjectUsageSummary,
  toUsageMetrics,
} from "./d1-records";

const userUsageRowsCte = `
  WITH user_usage_rows AS (
    SELECT
      agent_runs.user_id,
      agent_runs.project_id,
      projects.title AS project_title,
      0 AS project_deleted,
      agent_runs.agent_runtime_id,
      agent_runs.input_tokens,
      agent_runs.output_tokens,
      agent_runs.total_tokens,
      agent_runs.model_request_count,
      agent_runs.sandbox_duration_ms
    FROM agent_runs
    INNER JOIN projects ON projects.id = agent_runs.project_id
    WHERE agent_runs.user_id = ?

    UNION ALL

    SELECT
      archived_run_usage.user_id,
      archived_run_usage.project_id,
      archived_run_usage.project_title,
      1 AS project_deleted,
      archived_run_usage.agent_runtime_id,
      archived_run_usage.input_tokens,
      archived_run_usage.output_tokens,
      archived_run_usage.total_tokens,
      archived_run_usage.model_request_count,
      archived_run_usage.sandbox_duration_ms
    FROM archived_run_usage
    WHERE archived_run_usage.user_id = ?
  )
`;

export class D1UserUsageRepository implements UserUsageRepository {
  constructor(private readonly db: D1Database) {}

  async summarizeByUser(userId: string): Promise<UserUsageSummary> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `${userUsageRowsCte}
          SELECT
            COUNT(*) AS run_count,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(model_request_count), 0) AS model_request_count,
            COALESCE(SUM(sandbox_duration_ms), 0) AS sandbox_duration_ms
          FROM user_usage_rows`,
        )
        .bind(userId, userId),
      this.db
        .prepare(
          `${userUsageRowsCte}
          SELECT
            project_id,
            project_title,
            project_deleted,
            COUNT(*) AS run_count,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(model_request_count), 0) AS model_request_count,
            COALESCE(SUM(sandbox_duration_ms), 0) AS sandbox_duration_ms
          FROM user_usage_rows
          GROUP BY project_id, project_title, project_deleted
          ORDER BY total_tokens DESC, run_count DESC, project_title ASC, project_id ASC`,
        )
        .bind(userId, userId),
      this.db
        .prepare(
          `${userUsageRowsCte}
          SELECT
            agent_runtime_id,
            COUNT(*) AS run_count,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(model_request_count), 0) AS model_request_count,
            COALESCE(SUM(sandbox_duration_ms), 0) AS sandbox_duration_ms
          FROM user_usage_rows
          GROUP BY agent_runtime_id
          ORDER BY total_tokens DESC, run_count DESC, agent_runtime_id ASC`,
        )
        .bind(userId, userId),
    ]);

    const totals = requireBatchRow<UsageAggregateRow>(results, 0, "summarize user usage");
    const projects = (results[1]?.results ?? []) as ProjectUsageRow[];
    const agentRuntimes = (results[2]?.results ?? []) as AgentRuntimeUsageRow[];

    return {
      agentRuntimes: agentRuntimes.map(toAgentRuntimeUsageSummary),
      projects: projects.map(toProjectUsageSummary),
      totals: toUsageMetrics(totals),
    };
  }
}
