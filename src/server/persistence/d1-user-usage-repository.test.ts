import { describe, expect, it } from "vitest";

import { D1UserUsageRepository } from "./d1-repositories";
import { TestD1Database, result } from "./d1-test-database";

describe("D1 user usage repository", () => {
  it("aggregates all recorded Run usage for one user without filtering terminal status", async () => {
    const db = new TestD1Database();
    db.batchResults.push([
      result([
        {
          input_tokens: 150,
          model_request_count: 4,
          output_tokens: 90,
          run_count: 3,
          sandbox_duration_ms: 75_000,
          total_tokens: 240,
        },
      ]),
      result([
        {
          input_tokens: 100,
          model_request_count: 3,
          output_tokens: 60,
          project_deleted: 0,
          project_id: "project-1",
          project_title: "Alpha",
          run_count: 2,
          sandbox_duration_ms: 60_000,
          total_tokens: 160,
        },
        {
          input_tokens: 50,
          model_request_count: 1,
          output_tokens: 30,
          project_deleted: 1,
          project_id: "project-2",
          project_title: "Beta",
          run_count: 1,
          sandbox_duration_ms: 15_000,
          total_tokens: 80,
        },
      ]),
      result([
        {
          agent_runtime_id: "pi",
          input_tokens: 150,
          model_request_count: 4,
          output_tokens: 90,
          run_count: 3,
          sandbox_duration_ms: 75_000,
          total_tokens: 240,
        },
      ]),
    ]);

    const usage = await new D1UserUsageRepository(db.asBinding()).summarizeByUser("user-1");

    expect(usage).toEqual({
      agentRuntimes: [
        {
          agentRuntimeId: "pi",
          usage: {
            inputTokens: 150,
            modelRequestCount: 4,
            outputTokens: 90,
            runCount: 3,
            sandboxDurationMs: 75_000,
            totalTokens: 240,
          },
        },
      ],
      projects: [
        {
          projectDeleted: false,
          projectId: "project-1",
          projectTitle: "Alpha",
          usage: {
            inputTokens: 100,
            modelRequestCount: 3,
            outputTokens: 60,
            runCount: 2,
            sandboxDurationMs: 60_000,
            totalTokens: 160,
          },
        },
        {
          projectDeleted: true,
          projectId: "project-2",
          projectTitle: "Beta",
          usage: {
            inputTokens: 50,
            modelRequestCount: 1,
            outputTokens: 30,
            runCount: 1,
            sandboxDurationMs: 15_000,
            totalTokens: 80,
          },
        },
      ],
      totals: {
        inputTokens: 150,
        modelRequestCount: 4,
        outputTokens: 90,
        runCount: 3,
        sandboxDurationMs: 75_000,
        totalTokens: 240,
      },
    });
    expect(db.batches[0]).toHaveLength(3);
    for (const statement of db.batches[0] ?? []) {
      expect(statement.bindings).toEqual(["user-1", "user-1"]);
      expect(statement.query).not.toContain("status IN");
      expect(statement.query).toContain("UNION ALL");
      expect(statement.query).toContain("archived_run_usage");
    }
    expect(db.batches[0]?.[1]?.query).toContain(
      "GROUP BY project_id, project_title, project_deleted",
    );
    expect(db.batches[0]?.[2]?.query).toContain("GROUP BY agent_runtime_id");
  });
});
