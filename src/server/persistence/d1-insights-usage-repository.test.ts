import { describe, expect, it } from "vitest";
import { InsightsQueryBudgetExceeded } from "../../application/project-insights";
import { D1InsightsUsageRepository } from "./d1-insights-usage-repository";
import { TestD1Database, result } from "./d1-test-database";

describe("MCP all-time query budget", () => {
  it("counts current and archived rows together and refuses aggregation above budget", async () => {
    const db = new TestD1Database();
    db.batchResults.push([result([{ count: 60000 }]), result([{ count: 40001 }])]);
    await expect(
      new D1InsightsUsageRepository(db.asBinding()).summarizeByUser("owner"),
    ).rejects.toBeInstanceOf(InsightsQueryBudgetExceeded);
    expect(db.batches).toHaveLength(1);
    for (const statement of db.batches[0] ?? []) {
      expect(statement.bindings).toEqual(["owner"]);
      expect(statement.query).toContain("LIMIT 100001");
    }
  });
});
