import { InsightsQueryBudgetExceeded } from "../../application/project-insights";
import { D1UserUsageRepository } from "./d1-user-usage-repository";

/** Bounds all-time analytics work before invoking the shared usage calculation. */
export class D1InsightsUsageRepository extends D1UserUsageRepository {
  constructor(private readonly database: D1Database) {
    super(database);
  }

  override async summarizeByUser(userId: string) {
    const counts = await this.database.batch([
      this.database
        .prepare(
          "SELECT COUNT(*) AS count FROM (SELECT id FROM agent_runs WHERE user_id = ? LIMIT 100001)",
        )
        .bind(userId),
      this.database
        .prepare(
          "SELECT COUNT(*) AS count FROM (SELECT run_id FROM archived_run_usage WHERE user_id = ? LIMIT 100001)",
        )
        .bind(userId),
    ]);
    const total = counts.reduce(
      (sum, result) => sum + Number((result.results[0] as { count: number }).count),
      0,
    );
    if (total > 100000) throw new InsightsQueryBudgetExceeded();
    return super.summarizeByUser(userId);
  }
}
