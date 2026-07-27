import { describe, expect, it, vi } from "vitest";

import type { AgentRunRecord, SandboxLeaseRecord } from "../application/ports";
import { createServerServices } from "./services";
import type { AppBindings } from "./env";

describe("server service composition", () => {
  it("dispatches E2B runs to Workflow using application IDs only", async () => {
    const create = vi.fn(async () => ({ id: "run_1" }));
    const services = createServerServices({
      AGENT_RUN_WORKFLOW: { create } as unknown as AppBindings["AGENT_RUN_WORKFLOW"],
      ASSETS: {} as Fetcher,
      BETTER_AUTH_SECRET: "a".repeat(32),
      BETTER_AUTH_URL: "https://agent-online.example",
      DB: {} as D1Database,
      E2B_API_KEY: "e2b-key",
      E2B_TEMPLATE_ID: "agent-online-template",
      RUNTIME_PROVIDER: "e2b",
    });
    const run = createRun();

    const dispatched = await services.runExecutions.start({
      agentRun: run,
      prompt: "Private user prompt",
      sandboxLease: createLease(),
      workingDirectory: "/workspace",
    });

    expect(create).toHaveBeenCalledWith({
      id: "run_1",
      params: {
        kind: "execute",
        projectId: "project_1",
        runId: "run_1",
      },
      retention: {
        errorRetention: "1 day",
        successRetention: "1 day",
      },
    });
    expect(create.mock.calls.flat(Infinity)).not.toContain("Private user prompt");
    expect(dispatched.completion).toBeNull();
  });
});

function createRun(): AgentRunRecord {
  return {
    agentRuntimeId: "pi",
    createdAt: "2026-07-25T00:00:00.000Z",
    failureReason: null,
    finishedAt: null,
    id: "run_1",
    inputMessageId: "message_1",
    modelId: "gemini-2.5-flash",
    projectId: "project_1",
    providerProcessRef: null,
    sandboxLeaseId: "lease_1",
    sandboxRuntimeId: "e2b",
    startedAt: null,
    status: "queued",
    usage: {
      inputTokens: 0,
      modelRequestCount: 0,
      outputTokens: 0,
      sandboxDurationMs: 0,
      totalTokens: 0,
    },
    userId: "user_1",
  };
}

function createLease(): SandboxLeaseRecord {
  return {
    createdAt: "2026-07-25T00:00:00.000Z",
    id: "lease_1",
    projectId: "project_1",
    providerRef: null,
    runtimeId: "e2b",
    status: "stopped",
    updatedAt: "2026-07-25T00:00:00.000Z",
  };
}
