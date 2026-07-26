import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type {
  UserUsageQuery,
  UserUsageSummary,
} from "../application/user-usage";
import type { UserUsageResponse } from "../shared/api";
import type { AppEnv } from "./env";
import { createUsageApi } from "./usage-api";

const testUser = { email: "user@example.test", id: "user-1" };

const usageSummary: UserUsageSummary = {
  agentRuntimes: [
    {
      agentRuntimeId: "pi",
      usage: {
        inputTokens: 120,
        modelRequestCount: 2,
        outputTokens: 80,
        runCount: 2,
        sandboxDurationMs: 45_000,
        totalTokens: 200,
      },
    },
  ],
  projects: [
    {
      projectId: "project-1",
      projectTitle: "Demo",
      usage: {
        inputTokens: 120,
        modelRequestCount: 2,
        outputTokens: 80,
        runCount: 2,
        sandboxDurationMs: 45_000,
        totalTokens: 200,
      },
    },
  ],
  totals: {
    inputTokens: 120,
    modelRequestCount: 2,
    outputTokens: 80,
    runCount: 2,
    sandboxDurationMs: 45_000,
    totalTokens: 200,
  },
};

describe("Usage API", () => {
  it("rejects unauthenticated requests before querying usage", async () => {
    let queryCreated = false;
    const app = createTestApp({
      createUsageQuery: () => {
        queryCreated = true;
        return { getForUser: async () => usageSummary };
      },
      user: null,
    });

    const response = await app.request("http://agent-online.test/api/usage");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "unauthorized",
      requestId: "test-request",
    });
    expect(queryCreated).toBe(false);
  });

  it("returns only the authenticated user's all-time aggregate", async () => {
    let queriedUserId: string | null = null;
    const app = createTestApp({
      createUsageQuery: () => ({
        async getForUser(userId) {
          queriedUserId = userId;
          return usageSummary;
        },
      }),
      user: testUser,
    });

    const response = await app.request("http://agent-online.test/api/usage");
    const body = (await response.json()) as UserUsageResponse;

    expect(response.status).toBe(200);
    expect(queriedUserId).toBe(testUser.id);
    expect(body).toEqual({ ...usageSummary, scope: "all_time" });
    expect(JSON.stringify(body)).not.toContain(testUser.id);
    expect(JSON.stringify(body)).not.toContain("provider");
  });
});

function createTestApp({
  createUsageQuery,
  user,
}: {
  createUsageQuery: () => UserUsageQuery;
  user: typeof testUser | null;
}) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("requestId", "test-request");
    await next();
  });
  app.route(
    "/api",
    createUsageApi({
      createUsageQuery,
      getAuthenticatedUser: async () => user,
    }),
  );

  return app;
}
