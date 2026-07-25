import { describe, expect, it } from "vitest";

import {
  D1AgentRunRepository,
  D1MessageRepository,
  D1ProjectRepository,
  D1SandboxLeaseRepository,
} from "./d1-repositories";

type TestStatement = {
  bindings: unknown[];
  query: string;
};

type TestStatementHandle = D1PreparedStatement & {
  testStatement: TestStatement;
};

function result<T>(rows: T[] = [], changes = 1): D1Result<T> {
  return {
    meta: { changes },
    results: rows,
    success: true,
  } as D1Result<T>;
}

class TestD1Database {
  readonly allRows: unknown[][] = [];
  readonly batches: TestStatement[][] = [];
  readonly firstRows: unknown[] = [];
  readonly prepared: TestStatement[] = [];
  batchError: unknown = null;
  batchResults: D1Result<unknown>[][] = [];

  asBinding(): D1Database {
    return this as unknown as D1Database;
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.batches.push(statements.map((statement) => (statement as TestStatementHandle).testStatement));

    if (this.batchError !== null) {
      throw this.batchError;
    }

    return (this.batchResults.shift() ?? []) as D1Result<T>[];
  }

  prepare(query: string): D1PreparedStatement {
    const statement: TestStatement = { bindings: [], query };
    this.prepared.push(statement);

    const statementHandle = {
      all: async <T>() => result((this.allRows.shift() ?? []) as T[]),
      bind: (...values: unknown[]) => {
        statement.bindings = values;
        return statementHandle;
      },
      first: async <T>() => (this.firstRows.shift() ?? null) as T | null,
      raw: async () => [],
      run: async <T>() => result<T>(),
      testStatement: statement,
    } as unknown as TestStatementHandle;

    return statementHandle;
  }
}

describe("D1 persistence adapters", () => {
  it("maps owned Project rows from snake_case", async () => {
    const db = new TestD1Database();
    db.firstRows.push({
      created_at: "2026-07-25T00:00:00.000Z",
      default_agent_runtime_id: "pi",
      id: "project-1",
      title: "Example",
      updated_at: "2026-07-25T00:01:00.000Z",
      user_id: "user-1",
    });

    const project = await new D1ProjectRepository(db.asBinding()).findOwnedById("project-1", "user-1");

    expect(project).toEqual({
      createdAt: "2026-07-25T00:00:00.000Z",
      defaultAgentRuntimeId: "pi",
      id: "project-1",
      title: "Example",
      updatedAt: "2026-07-25T00:01:00.000Z",
      userId: "user-1",
    });
  });

  it("lists visible messages by Project in sequence order", async () => {
    const db = new TestD1Database();
    db.allRows.push([
      {
        agent_run_id: null,
        content: "First message",
        created_at: "2026-07-25T00:00:00.000Z",
        id: "message-1",
        project_id: "project-1",
        role: "user",
        sequence: 0,
      },
      {
        agent_run_id: "run-1",
        content: "Final answer",
        created_at: "2026-07-25T00:01:00.000Z",
        id: "message-2",
        project_id: "project-1",
        role: "assistant",
        sequence: 1,
      },
    ]);

    const messages = await new D1MessageRepository(db.asBinding()).listByProjectId("project-1");

    expect(messages).toEqual([
      {
        agentRunId: null,
        content: "First message",
        createdAt: "2026-07-25T00:00:00.000Z",
        id: "message-1",
        projectId: "project-1",
        role: "user",
        sequence: 0,
      },
      {
        agentRunId: "run-1",
        content: "Final answer",
        createdAt: "2026-07-25T00:01:00.000Z",
        id: "message-2",
        projectId: "project-1",
        role: "assistant",
        sequence: 1,
      },
    ]);
    expect(db.prepared[0]?.query).toContain("ORDER BY sequence ASC");
    expect(db.prepared[0]?.bindings).toEqual(["project-1"]);
  });

  it("gets or creates one logical sandbox lease in one batch", async () => {
    const db = new TestD1Database();
    db.batchResults.push([
      result(),
      result([
        {
          created_at: "2026-07-25T00:00:00.000Z",
          id: "lease-1",
          project_id: "project-1",
          provider_ref: null,
          sandbox_runtime_id: "fake",
          status: "stopped",
          updated_at: "2026-07-25T00:00:00.000Z",
        },
      ]),
    ]);

    const lease = await new D1SandboxLeaseRepository(db.asBinding()).getOrCreate({
      id: "lease-1",
      now: "2026-07-25T00:00:00.000Z",
      projectId: "project-1",
      runtimeId: "fake",
    });

    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toHaveLength(2);
    expect(db.batches[0]?.[0]?.query).toContain("ON CONFLICT(project_id) DO NOTHING");
    expect(lease).toMatchObject({ id: "lease-1", projectId: "project-1", runtimeId: "fake" });
  });

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
          agent_runtime_id: "pi",
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
      agentRuntimeId: "pi",
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
      run: { id: "run-1", status: "queued", usage: { totalTokens: 0 } },
    });
    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toHaveLength(4);
    expect(db.batches[0]?.[0]?.query).toContain("INSERT INTO messages");
    expect(db.batches[0]?.[1]?.query).toContain("INSERT INTO agent_runs");
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

    const run = await new D1AgentRunRepository(db.asBinding()).findActiveOwnedByProjectId("project-1", "user-1");

    expect(run).toMatchObject({
      id: "run-2",
      projectId: "project-1",
      status: "running",
      usage: { inputTokens: 4, outputTokens: 8, totalTokens: 12 },
      userId: "user-1",
    });
    expect(db.prepared[0]?.query).toContain("status IN ('queued', 'starting', 'running', 'cancelling')");
    expect(db.prepared[0]?.query).toContain("ORDER BY created_at DESC, id DESC");
    expect(db.prepared[0]?.bindings).toEqual(["project-1", "user-1"]);
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
});
