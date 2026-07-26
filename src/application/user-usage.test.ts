import { describe, expect, it } from "vitest";

import type {
  UserUsageRepository,
  UserUsageSummary,
} from "./user-usage";
import { UserUsageService } from "./user-usage";

const summary: UserUsageSummary = {
  agentRuntimes: [],
  projects: [],
  totals: {
    inputTokens: 0,
    modelRequestCount: 0,
    outputTokens: 0,
    runCount: 0,
    sandboxDurationMs: 0,
    totalTokens: 0,
  },
};

describe("UserUsageService", () => {
  it("queries usage inside the authenticated user boundary", async () => {
    let queriedUserId: string | null = null;
    const repository: UserUsageRepository = {
      async summarizeByUser(userId) {
        queriedUserId = userId;
        return summary;
      },
    };

    const result = await new UserUsageService(repository).getForUser("user-1");

    expect(queriedUserId).toBe("user-1");
    expect(result).toBe(summary);
  });

  it("rejects an empty user boundary before querying persistence", () => {
    const repository: UserUsageRepository = {
      async summarizeByUser() {
        throw new Error("Persistence should not be called");
      },
    };

    expect(() => new UserUsageService(repository).getForUser("")).toThrow(
      "User ID is required",
    );
  });
});
