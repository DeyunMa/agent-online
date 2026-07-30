import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { D1AgentRunRepository, D1ProjectRepository } from "./d1-repositories";

const createdAt = "2026-07-27T00:00:00.000Z";
const finishedAt = "2026-07-27T00:00:10.000Z";

describe("D1 repositories in the Workers runtime", () => {
  beforeEach(async () => {
    await resetProductData();
    await seedProject();
  });

  it("applies every migration with valid foreign keys and integrity triggers", async () => {
    const migrations = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY name").all<{
      name: string;
    }>();
    const triggers = await env.DB.prepare(
      `SELECT name
      FROM sqlite_master
      WHERE type = 'trigger'
      ORDER BY name`,
    ).all<{ name: string }>();
    const foreignKeyFailures = await env.DB.prepare("PRAGMA foreign_key_check").all();

    expect(migrations.results.map(({ name }) => name)).toEqual([
      "0001_app.sql",
      "0002_d2_run_execution.sql",
      "0003_provider_process_ref.sql",
      "0004_terminal_sessions.sql",
      "0005_preview_sessions.sql",
      "0006_integrity_guards.sql",
      "0007_agent_run_failure_codes.sql",
      "0008_archived_run_usage.sql",
    ]);
    expect(triggers.results.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "agent_runs_validate_insert_ownership",
        "agent_runs_validate_failure_code_insert",
        "agent_runs_validate_failure_code_update",
        "agent_runs_validate_status_transition",
        "messages_validate_agent_link",
        "preview_sessions_validate_lease",
        "terminal_sessions_validate_lease",
      ]),
    );
    expect(foreignKeyFailures.results).toEqual([]);
  });

  it("renames an owned Project and hard-deletes all of its product rows", async () => {
    const agentRuns = new D1AgentRunRepository(env.DB);
    const projects = new D1ProjectRepository(env.DB);
    await createRunningRun(agentRuns);
    await agentRuns.transition({
      failureCode: "run.interrupted",
      finishedAt,
      from: "running",
      runId: "run_1",
      to: "interrupted",
    });

    const renamed = await projects.renameOwned({
      projectId: "project_1",
      title: "Renamed Project",
      updatedAt: finishedAt,
      userId: "user_1",
    });
    const deleted = await projects.deleteOwned({
      deletedAt: "2026-07-27T00:01:00.000Z",
      projectId: "project_1",
      userId: "user_1",
    });
    const counts = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM archived_run_usage) AS archived_usage,
        (SELECT COUNT(*) FROM projects) AS projects,
        (SELECT COUNT(*) FROM sandbox_leases) AS leases,
        (SELECT COUNT(*) FROM messages) AS messages,
        (SELECT COUNT(*) FROM agent_runs) AS runs`,
    ).first<{
      archived_usage: number;
      leases: number;
      messages: number;
      projects: number;
      runs: number;
    }>();

    expect(renamed).toMatchObject({ title: "Renamed Project", updatedAt: finishedAt });
    expect(deleted).toBe(true);
    expect(counts).toEqual({
      archived_usage: 1,
      leases: 0,
      messages: 0,
      projects: 0,
      runs: 0,
    });
    await expect(env.DB.prepare("PRAGMA foreign_key_check").all()).resolves.toMatchObject({
      results: [],
    });
  });

  it("commits Run success, usage, assistant Message, and Project touch together", async () => {
    const repository = new D1AgentRunRepository(env.DB);
    await createRunningRun(repository);
    await repository.setProviderProcessRef("run_1", "private-process-ref");

    const completed = await repository.completeSucceeded({
      assistantMessage: {
        content: "Visible final answer",
        id: "message_assistant_1",
      },
      finishedAt,
      runId: "run_1",
      sandboxDurationMs: 9_500,
    });
    const messages = await env.DB.prepare(
      `SELECT agent_run_id, content, role, sequence
      FROM messages
      WHERE project_id = 'project_1'
      ORDER BY sequence`,
    ).all<{
      agent_run_id: string | null;
      content: string;
      role: string;
      sequence: number;
    }>();
    const project = await env.DB.prepare(
      "SELECT updated_at FROM projects WHERE id = 'project_1'",
    ).first<{ updated_at: string }>();

    expect(completed).toMatchObject({
      finishedAt,
      providerProcessRef: null,
      status: "succeeded",
      usage: {
        sandboxDurationMs: 9_500,
      },
    });
    expect(messages.results).toEqual([
      {
        agent_run_id: null,
        content: "Create a file",
        role: "user",
        sequence: 0,
      },
      {
        agent_run_id: "run_1",
        content: "Visible final answer",
        role: "assistant",
        sequence: 1,
      },
    ]);
    expect(project?.updated_at).toBe(finishedAt);
  });

  it("does not persist an assistant Message when cancellation wins completion", async () => {
    const repository = new D1AgentRunRepository(env.DB);
    await createRunningRun(repository);
    await repository.transition({
      from: "running",
      runId: "run_1",
      to: "cancelling",
    });

    const completed = await repository.completeSucceeded({
      assistantMessage: {
        content: "Must not be visible",
        id: "message_assistant_1",
      },
      finishedAt,
      runId: "run_1",
      sandboxDurationMs: 9_500,
    });
    const messageCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE role = 'assistant'",
    ).first<{ count: number }>();

    expect(completed).toBeNull();
    expect(messageCount?.count).toBe(0);
  });

  it("rolls back user Message creation when Run ownership is inconsistent", async () => {
    const repository = new D1AgentRunRepository(env.DB);
    await seedUser("user_2", "other@example.com");

    await expect(
      repository.createQueuedWithInput({
        agentRunId: "run_wrong_owner",
        agentRuntimeId: "pi",
        content: "Must roll back",
        inputMessageId: "message_wrong_owner",
        modelId: "gemini-3.6-flash",
        now: createdAt,
        projectId: "project_1",
        sandboxLeaseId: "lease_1",
        sandboxRuntimeId: "fake",
        userId: "user_2",
      }),
    ).rejects.toThrow(/invalid_agent_run_ownership/);

    const message = await env.DB.prepare(
      "SELECT id FROM messages WHERE id = 'message_wrong_owner'",
    ).first();
    expect(message).toBeNull();
  });

  it("rejects status transitions that bypass the domain state machine", async () => {
    await env.DB.prepare(
      `INSERT INTO messages (
        id, project_id, agent_run_id, sequence, role, content, created_at
      ) VALUES (
        'message_queued', 'project_1', NULL, 0, 'user', 'Queued input', ?
      )`,
    )
      .bind(createdAt)
      .run();
    await env.DB.prepare(
      `INSERT INTO agent_runs (
        id, user_id, project_id, input_message_id, sandbox_lease_id,
        agent_runtime_id, sandbox_runtime_id, model_id, status, created_at
      ) VALUES (
        'run_queued', 'user_1', 'project_1', 'message_queued', 'lease_1',
        'pi', 'fake', 'gemini-3.6-flash', 'queued', ?
      )`,
    )
      .bind(createdAt)
      .run();

    await expect(
      env.DB.prepare("UPDATE agent_runs SET status = 'succeeded' WHERE id = 'run_queued'").run(),
    ).rejects.toThrow(/invalid_agent_run_transition/);
  });

  it("requires stable failure codes for terminal Run failures", async () => {
    const repository = new D1AgentRunRepository(env.DB);
    await createRunningRun(repository);

    await expect(
      env.DB.prepare(
        "UPDATE agent_runs SET failure_code = 'run.internal_failed' WHERE id = 'run_1'",
      ).run(),
    ).rejects.toThrow(/invalid_agent_run_failure_code/);

    await expect(
      env.DB.prepare(
        "UPDATE agent_runs SET status = 'failed', failure_code = NULL WHERE id = 'run_1'",
      ).run(),
    ).rejects.toThrow(/invalid_agent_run_failure_code/);

    await expect(
      env.DB.prepare(
        `UPDATE agent_runs
        SET status = 'timed_out', failure_code = 'run.internal_failed'
        WHERE id = 'run_1'`,
      ).run(),
    ).rejects.toThrow(/invalid_agent_run_failure_code/);

    const failed = await repository.transition({
      failureCode: "run.model_failed",
      finishedAt,
      from: "running",
      runId: "run_1",
      to: "failed",
    });

    expect(failed).toMatchObject({
      failureCode: "run.model_failed",
      status: "failed",
    });
  });
});

async function createRunningRun(repository: D1AgentRunRepository) {
  const created = await repository.createQueuedWithInput({
    agentRunId: "run_1",
    agentRuntimeId: "pi",
    content: "Create a file",
    inputMessageId: "message_user_1",
    modelId: "gemini-3.6-flash",
    now: createdAt,
    projectId: "project_1",
    sandboxLeaseId: "lease_1",
    sandboxRuntimeId: "fake",
    userId: "user_1",
  });
  if (created.kind !== "created") {
    throw new Error("Unable to create test AgentRun");
  }
  await repository.transition({
    from: "queued",
    runId: "run_1",
    startedAt: createdAt,
    to: "starting",
  });
  await repository.transition({
    from: "starting",
    runId: "run_1",
    to: "running",
  });
}

async function resetProductData() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM preview_sessions"),
    env.DB.prepare("DELETE FROM terminal_sessions"),
    env.DB.prepare("DELETE FROM archived_run_usage"),
    env.DB.prepare("DELETE FROM agent_runs"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM sandbox_leases"),
    env.DB.prepare("DELETE FROM projects"),
    env.DB.prepare("DELETE FROM user"),
  ]);
}

async function seedProject() {
  await seedUser("user_1", "owner@example.com");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO projects (
          id, user_id, title, default_agent_runtime_id, created_at, updated_at
        ) VALUES ('project_1', 'user_1', 'Project', 'pi', ?, ?)`,
    ).bind(createdAt, createdAt),
    env.DB.prepare(
      `INSERT INTO sandbox_leases (
          id, project_id, sandbox_runtime_id, provider_ref, status,
          created_at, updated_at
        ) VALUES (
          'lease_1', 'project_1', 'fake', NULL, 'stopped', ?, ?
        )`,
    ).bind(createdAt, createdAt),
  ]);
}

async function seedUser(id: string, email: string) {
  await env.DB.prepare(
    `INSERT INTO user (
      id, name, email, emailVerified, image, createdAt, updatedAt
    ) VALUES (?, 'Test User', ?, 1, NULL, ?, ?)`,
  )
    .bind(id, email, createdAt, createdAt)
    .run();
}
