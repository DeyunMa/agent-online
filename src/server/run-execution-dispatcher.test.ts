import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRunRecord } from "../application/ports";
import type { AppBindings } from "./env";
import { createWorkflowDispatcher } from "./run-execution-dispatcher";

const { cancel } = vi.hoisted(() => ({ cancel: vi.fn() }));
vi.mock("./e2b-run-execution", () => ({
  createE2BRunExecution: () => ({ service: { cancel } }),
}));
vi.mock("./observability/reporter", () => ({
  createDiagnosticReporter: () => ({ report: vi.fn() }),
}));

describe("Workflow cancellation dispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the execution owner alive while startup cancellation is pending", async () => {
    const fixture = createFixture();
    cancel.mockResolvedValue({ ...run, status: "cancelling" });

    const result = await fixture.dispatcher.cancel(run, new Date());

    expect(result?.status).toBe("cancelling");
    expect(fixture.get).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("terminates the Workflow and schedules idle cleanup only after confirmed cancellation", async () => {
    const fixture = createFixture();
    cancel.mockResolvedValue({ ...run, status: "cancelled" });

    await fixture.dispatcher.cancel(run, new Date());

    expect(fixture.get).toHaveBeenCalledWith(run.id);
    expect(fixture.terminate).toHaveBeenCalledOnce();
    expect(fixture.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `idle-${run.id}`,
        params: { kind: "idle-cleanup", projectId: run.projectId, runId: run.id },
      }),
    );
  });

  it("preserves the Workflow recovery path when provider termination fails", async () => {
    const fixture = createFixture();
    cancel.mockRejectedValue(new Error("Run process termination could not be confirmed"));

    await expect(fixture.dispatcher.cancel(run, new Date())).rejects.toThrow(
      "Run process termination could not be confirmed",
    );
    expect(fixture.get).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  });
});

function createFixture() {
  const terminate = vi.fn().mockResolvedValue(undefined);
  const get = vi.fn().mockResolvedValue({
    status: async () => ({ status: "running" }),
    terminate,
  });
  const create = vi.fn().mockResolvedValue({});
  const env = {
    AGENT_RUN_WORKFLOW: { create, get } as unknown as Workflow,
    ASSETS: {} as Fetcher,
    DB: {} as D1Database,
  } satisfies AppBindings;
  return { create, dispatcher: createWorkflowDispatcher(env), get, terminate };
}

const run: AgentRunRecord = {
  agentRuntimeId: "pi",
  createdAt: "2026-09-07T00:00:00.000Z",
  failureCode: null,
  finishedAt: null,
  id: "run-1",
  inputMessageId: "message-1",
  modelId: "gemini-3.6-flash",
  projectId: "project-1",
  providerProcessRef: null,
  sandboxLeaseId: "lease-1",
  sandboxRuntimeId: "e2b",
  startedAt: "2026-09-07T00:00:01.000Z",
  status: "starting",
  usage: {
    inputTokens: 0,
    modelRequestCount: 0,
    outputTokens: 0,
    sandboxDurationMs: 0,
    totalTokens: 0,
  },
  userId: "user-1",
};
