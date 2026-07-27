import { describe, expect, it } from "vitest";

import { D1AgentRunRepository } from "./d1-repositories";
import { TestD1Database, result } from "./d1-test-database";

describe("D1 AgentRun repository", () => {
  it("creates the user message and queued AgentRun in one batch", async () => {
    const db = new TestD1Database();
    db.batchResults.push([
      result(),
      result(),
      result([
        {
          agent_run_id: null,
          content: "Build a demo",
          created_at: "2026-07-25T00:00:00.000Z",
          id: "message-1",
          project_id: "project-1",
          role: "user",
          sequence: 0,
        },
      ]),
      result([
        {
          agent_runtime_id: "goose",
          created_at: "2026-07-25T00:00:00.000Z",
          failure_reason: null,
          finished_at: null,
          id: "run-1",
          input_message_id: "message-1",
          input_tokens: 0,
          model_id: "gemini-2.5-flash",
          model_request_count: 0,
          output_tokens: 0,
          project_id: "project-1",
          sandbox_duration_ms: 0,
          sandbox_lease_id: "lease-1",
          sandbox_runtime_id: "fake",
          started_at: null,
          status: "queued",
          total_tokens: 0,
          user_id: "user-1",
        },
      ]),
    ]);

    const created = await new D1AgentRunRepository(db.asBinding()).createQueuedWithInput({
      agentRunId: "run-1",
      agentRuntimeId: "goose",
      content: "Build a demo",
      inputMessageId: "message-1",
      modelId: "gemini-2.5-flash",
      now: "2026-07-25T00:00:00.000Z",
      projectId: "project-1",
      sandboxLeaseId: "lease-1",
      sandboxRuntimeId: "fake",
      userId: "user-1",
    });

    expect(created).toMatchObject({
      inputMessage: { agentRunId: null, id: "message-1", sequence: 0 },
      kind: "created",
      run: {
        agentRuntimeId: "goose",
        id: "run-1",
        status: "queued",
        usage: { totalTokens: 0 },
      },
    });
    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toHaveLength(4);
    expect(db.batches[0]?.[0]?.query).toContain("INSERT INTO messages");
    expect(db.batches[0]?.[1]?.query).toContain("INSERT INTO agent_runs");
  });

  it("completes the Run, assistant Message, duration, and Project touch in one batch", async () => {
    const db = new TestD1Database();
    db.batchResults.push([
      result(),
      result(),
      result(),
      result([
        {
          agent_runtime_id: "pi",
          created_at: "2026-07-25T00:00:00.000Z",
          failure_reason: null,
          finished_at: "2026-07-25T00:01:00.000Z",
          id: "run-1",
          input_message_id: "message-1",
          input_tokens: 10,
          model_id: "gemini-2.5-flash",
          model_request_count: 1,
          output_tokens: 5,
          project_id: "project-1",
          provider_process_ref: null,
          sandbox_duration_ms: 60_000,
          sandbox_lease_id: "lease-1",
          sandbox_runtime_id: "e2b",
          started_at: "2026-07-25T00:00:00.000Z",
          status: "succeeded",
          total_tokens: 15,
          user_id: "user-1",
        },
      ]),
    ]);

    const completed = await new D1AgentRunRepository(db.asBinding()).completeSucceeded({
      assistantMessage: {
        content: "Final answer",
        id: "message-2",
      },
      finishedAt: "2026-07-25T00:01:00.000Z",
      runId: "run-1",
      sandboxDurationMs: 60_000,
    });

    expect(completed).toMatchObject({
      finishedAt: "2026-07-25T00:01:00.000Z",
      id: "run-1",
      status: "succeeded",
      usage: { sandboxDurationMs: 60_000 },
    });
    expect(db.batches[0]).toHaveLength(4);
    expect(db.batches[0]?.[0]?.query).toContain("AND status = 'running'");
    expect(db.batches[0]?.[1]?.query).toContain("INSERT OR IGNORE INTO messages");
    expect(db.batches[0]?.[2]?.query).toContain("UPDATE projects");
  });

  it("rejects invalid AgentRun transitions before issuing SQL", async () => {
    const db = new TestD1Database();

    await expect(
      new D1AgentRunRepository(db.asBinding()).transition({
        from: "cancelling",
        runId: "run-1",
        to: "succeeded",
      }),
    ).rejects.toThrow("Invalid AgentRun transition from cancelling to succeeded");
    expect(db.batches).toEqual([]);
  });

  it("converts the active AgentRun unique-index collision into project_busy", async () => {
    const db = new TestD1Database();
    db.batchError = new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed: agent_runs.project_id");

    await expect(
      new D1AgentRunRepository(db.asBinding()).createQueuedWithInput({
        agentRunId: "run-2",
        agentRuntimeId: "pi",
        content: "A second request",
        inputMessageId: "message-2",
        modelId: "gemini-2.5-flash",
        now: "2026-07-25T00:01:00.000Z",
        projectId: "project-1",
        sandboxLeaseId: "lease-1",
        sandboxRuntimeId: "fake",
        userId: "user-1",
      }),
    ).resolves.toEqual({ kind: "project_busy" });
  });

  it("converts the active Terminal trigger into AgentRun project_busy", async () => {
    const db = new TestD1Database();
    db.batchError = new Error("SQLITE_CONSTRAINT_TRIGGER: project_terminal_active");

    await expect(
      new D1AgentRunRepository(db.asBinding()).createQueuedWithInput({
        agentRunId: "run-2",
        agentRuntimeId: "pi",
        content: "A request while the terminal is open",
        inputMessageId: "message-2",
        modelId: "gemini-2.5-flash",
        now: "2026-07-25T00:01:00.000Z",
        projectId: "project-1",
        sandboxLeaseId: "lease-1",
        sandboxRuntimeId: "fake",
        userId: "user-1",
      }),
    ).resolves.toEqual({ kind: "project_busy" });
  });

  it("finds the newest active AgentRun owned by the Project user", async () => {
    const db = new TestD1Database();
    db.firstRows.push({
      agent_runtime_id: "pi",
      created_at: "2026-07-25T00:01:00.000Z",
      failure_reason: null,
      finished_at: null,
      id: "run-2",
      input_message_id: "message-2",
      input_tokens: 4,
      model_id: "gemini-2.5-flash",
      model_request_count: 1,
      output_tokens: 8,
      project_id: "project-1",
      sandbox_duration_ms: 100,
      sandbox_lease_id: "lease-1",
      sandbox_runtime_id: "fake",
      started_at: "2026-07-25T00:01:01.000Z",
      status: "running",
      total_tokens: 12,
      user_id: "user-1",
    });

    const run = await new D1AgentRunRepository(db.asBinding()).findActiveOwnedByProjectId(
      "project-1",
      "user-1",
    );

    expect(run).toMatchObject({
      id: "run-2",
      projectId: "project-1",
      status: "running",
      usage: { inputTokens: 4, outputTokens: 8, totalTokens: 12 },
      userId: "user-1",
    });
    expect(db.prepared[0]?.query).toContain(
      "status IN ('queued', 'starting', 'running', 'cancelling')",
    );
    expect(db.prepared[0]?.query).toContain("ORDER BY created_at DESC, id DESC");
    expect(db.prepared[0]?.bindings).toEqual(["project-1", "user-1"]);
  });

  it("lists a bounded recent AgentRun history for the owning user", async () => {
    const db = new TestD1Database();
    db.allRows.push([
      {
        agent_runtime_id: "pi",
        created_at: "2026-07-25T00:02:00.000Z",
        failure_reason: null,
        finished_at: "2026-07-25T00:03:00.000Z",
        id: "run-2",
        input_message_id: "message-2",
        input_tokens: 10,
        model_id: "gemini-2.5-flash",
        model_request_count: 1,
        output_tokens: 20,
        project_id: "project-1",
        sandbox_duration_ms: 60_000,
        sandbox_lease_id: "lease-1",
        sandbox_runtime_id: "fake",
        started_at: "2026-07-25T00:02:01.000Z",
        status: "succeeded",
        total_tokens: 30,
        user_id: "user-1",
      },
    ]);

    const runs = await new D1AgentRunRepository(db.asBinding()).listRecentOwnedByProjectId(
      "project-1",
      "user-1",
    );

    expect(runs).toMatchObject([
      {
        id: "run-2",
        projectId: "project-1",
        status: "succeeded",
        usage: { modelRequestCount: 1, sandboxDurationMs: 60_000, totalTokens: 30 },
      },
    ]);
    expect(db.prepared[0]?.query).toContain("ORDER BY created_at DESC, id DESC");
    expect(db.prepared[0]?.query).toContain("LIMIT 50");
    expect(db.prepared[0]?.bindings).toEqual(["project-1", "user-1"]);
  });

  it("atomically adds non-terminal AgentRun usage deltas", async () => {
    const db = new TestD1Database();
    db.batchResults.push([
      result(),
      result([
        {
          agent_runtime_id: "pi",
          created_at: "2026-07-25T00:02:00.000Z",
          failure_reason: null,
          finished_at: null,
          id: "run-2",
          input_message_id: "message-2",
          input_tokens: 13,
          model_id: "gemini-2.5-flash",
          model_request_count: 2,
          output_tokens: 22,
          project_id: "project-1",
          sandbox_duration_ms: 500,
          sandbox_lease_id: "lease-1",
          sandbox_runtime_id: "fake",
          started_at: "2026-07-25T00:02:01.000Z",
          status: "running",
          total_tokens: 35,
          user_id: "user-1",
        },
      ]),
    ]);

    const run = await new D1AgentRunRepository(db.asBinding()).addUsageDelta("run-2", {
      inputTokens: 3,
      modelRequestCount: 1,
      outputTokens: 2,
      sandboxDurationMs: 500,
      totalTokens: 5,
    });

    expect(run?.usage).toEqual({
      inputTokens: 13,
      modelRequestCount: 2,
      outputTokens: 22,
      sandboxDurationMs: 500,
      totalTokens: 35,
    });
    expect(db.batches[0]?.[0]?.query).toContain("input_tokens = input_tokens + ?");
    expect(db.batches[0]?.[0]?.query).toContain(
      "status IN ('queued', 'starting', 'running', 'cancelling')",
    );
    expect(db.batches[0]?.[0]?.bindings).toEqual([3, 2, 5, 1, 500, "run-2"]);
  });

  it("records sandbox duration idempotently with MAX", async () => {
    const db = new TestD1Database();
    db.batchResults.push([
      result(),
      result([
        {
          agent_runtime_id: "pi",
          created_at: "2026-07-25T00:02:00.000Z",
          failure_reason: null,
          finished_at: null,
          id: "run-2",
          input_message_id: "message-2",
          input_tokens: 10,
          model_id: "gemini-2.5-flash",
          model_request_count: 1,
          output_tokens: 20,
          project_id: "project-1",
          provider_process_ref: "42",
          sandbox_duration_ms: 60_000,
          sandbox_lease_id: "lease-1",
          sandbox_runtime_id: "e2b",
          started_at: "2026-07-25T00:02:01.000Z",
          status: "running",
          total_tokens: 30,
          user_id: "user-1",
        },
      ]),
    ]);

    const run = await new D1AgentRunRepository(db.asBinding()).setSandboxDuration("run-2", 60_000);

    expect(run).toMatchObject({
      providerProcessRef: "42",
      usage: { sandboxDurationMs: 60_000 },
    });
    expect(db.batches[0]?.[0]?.query).toContain(
      "sandbox_duration_ms = MAX(sandbox_duration_ms, ?)",
    );
    expect(db.batches[0]?.[0]?.bindings).toEqual([60_000, "run-2"]);
  });

  it("rejects invalid AgentRun usage deltas before accessing D1", async () => {
    const db = new TestD1Database();

    await expect(
      new D1AgentRunRepository(db.asBinding()).addUsageDelta("run-2", {
        inputTokens: -1,
        modelRequestCount: 0,
        outputTokens: 0,
        sandboxDurationMs: 0,
        totalTokens: 0,
      }),
    ).rejects.toThrow("non-negative safe integers");
    expect(db.batches).toHaveLength(0);
  });

  it("reads an AgentRun by id for the internal coordinator", async () => {
    const db = new TestD1Database();
    db.firstRows.push({
      agent_runtime_id: "pi",
      created_at: "2026-07-25T00:01:00.000Z",
      failure_reason: null,
      finished_at: null,
      id: "run-1",
      input_message_id: "message-1",
      input_tokens: 4,
      model_id: "gemini-2.5-flash",
      model_request_count: 1,
      output_tokens: 8,
      project_id: "project-1",
      sandbox_duration_ms: 100,
      sandbox_lease_id: "lease-1",
      sandbox_runtime_id: "fake",
      started_at: "2026-07-25T00:01:01.000Z",
      status: "cancelling",
      total_tokens: 12,
      user_id: "user-1",
    });

    const run = await new D1AgentRunRepository(db.asBinding()).findById("run-1");

    expect(run).toMatchObject({ id: "run-1", status: "cancelling" });
    expect(db.prepared[0]?.query).toContain("WHERE id = ? LIMIT 1");
    expect(db.prepared[0]?.bindings).toEqual(["run-1"]);
  });

  it("finds a Project's active AgentRun without requiring browser ownership input", async () => {
    const db = new TestD1Database();
    db.firstRows.push({
      agent_runtime_id: "pi",
      created_at: "2026-07-25T00:01:00.000Z",
      failure_reason: null,
      finished_at: null,
      id: "run-1",
      input_message_id: "message-1",
      input_tokens: 0,
      model_id: "gemini-2.5-flash",
      model_request_count: 0,
      output_tokens: 0,
      project_id: "project-1",
      sandbox_duration_ms: 0,
      sandbox_lease_id: "lease-1",
      sandbox_runtime_id: "e2b",
      started_at: null,
      status: "queued",
      total_tokens: 0,
      user_id: "user-1",
    });

    const run = await new D1AgentRunRepository(db.asBinding()).findActiveByProjectId("project-1");

    expect(run).toMatchObject({ id: "run-1", projectId: "project-1", status: "queued" });
    expect(db.prepared[0]?.query).toContain(
      "status IN ('queued', 'starting', 'running', 'cancelling')",
    );
    expect(db.prepared[0]?.bindings).toEqual(["project-1"]);
  });
});
