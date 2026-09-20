import { env } from "cloudflare:workers";
import { getTableName, sql } from "drizzle-orm";
import { getTableConfig, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  D1AgentRunRepository,
  D1MessageRepository,
  D1ProjectRepository,
  D1SandboxLeaseRepository,
} from "./d1-repositories";
import * as schema from "./schema";

const createdAt = "2026-07-27T00:00:00.000Z";
const finishedAt = "2026-07-27T00:00:10.000Z";

describe("D1 repositories in the Workers runtime", () => {
  beforeEach(async () => {
    await resetProductData();
    await seedProject();
  });

  it("pages messages and Runs without gaps across equal timestamps and isolates owners", async () => {
    const messages = new D1MessageRepository(env.DB);
    const runs = new D1AgentRunRepository(env.DB);
    for (let i = 0; i < 55; i += 1) {
      const id = `page-run-${String(i).padStart(3, "0")}`;
      const result = await runs.createQueuedWithInput({
        agentRunId: id,
        agentRuntimeId: "pi",
        content: `Message ${i}`,
        inputMessageId: `page-message-${i}`,
        modelId: "gemini-3.6-flash",
        now: createdAt,
        projectId: "project_1",
        sandboxLeaseId: "lease_1",
        sandboxRuntimeId: "fake",
        userId: "user_1",
      });
      expect(result.kind).toBe("created");
      await runs.transition({ runId: id, from: "queued", to: "cancelled", finishedAt });
    }
    const latest = await messages.listByProjectId("project_1");
    expect(latest).toHaveLength(51);
    expect(latest[0]?.sequence).toBe(54);
    const firstPage = latest.slice(0, 50);
    const oldest = firstPage.at(-1);
    if (!oldest) throw new Error("Missing message page");
    const earlier = await messages.listByProjectId("project_1", { before: oldest.sequence });
    expect(earlier.map((row) => row.sequence)).toEqual([4, 3, 2, 1, 0]);
    const delta = await messages.listByProjectId("project_1", { after: 51 });
    expect(delta.map((row) => row.sequence)).toEqual([52, 53, 54]);
    const runPage = (await runs.listRecentOwnedByProjectId("project_1", "user_1")).slice(0, 50);
    const lastRun = runPage.at(-1);
    if (!lastRun) throw new Error("Missing Run page");
    const remaining = await runs.listRecentOwnedByProjectId("project_1", "user_1", {
      at: lastRun.createdAt,
      id: lastRun.id,
    });
    expect(remaining).toHaveLength(5);
    expect(new Set([...runPage, ...remaining].map((run) => run.id)).size).toBe(55);
    expect(
      await runs.listRecentOwnedByProjectId("project_1", "other_user", {
        at: lastRun.createdAt,
        id: lastRun.id,
      }),
    ).toEqual([]);
  });

  it("pages Projects using both update time and id", async () => {
    const repository = new D1ProjectRepository(env.DB);
    for (let i = 0; i < 55; i += 1) {
      await repository.create({
        id: `project-page-${String(i).padStart(3, "0")}`,
        userId: "user_1",
        title: "Paged Project",
        defaultAgentRuntimeId: "pi",
        now: createdAt,
      });
    }
    const first = (await repository.listOwned("user_1")).slice(0, 50);
    const last = first.at(-1);
    if (!last) throw new Error("Missing Project page");
    const next = await repository.listOwned("user_1", { at: last.updatedAt, id: last.id });
    expect(next).toHaveLength(6);
    expect(new Set([...first, ...next].map((project) => project.id)).size).toBe(56);
    expect(await repository.listOwned("other_user", { at: last.updatedAt, id: last.id })).toEqual(
      [],
    );
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
      "0009_resource_admission.sql",
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

  it("keeps the typed schema aligned with migrated D1 columns, keys, indexes and checks", async () => {
    const dialect = new SQLiteSyncDialect();
    const normalize = (value: string) =>
      value
        .toLowerCase()
        .replace(/"[^"]+"\./g, "")
        .replace(/["`\s]/g, "");
    for (const table of Object.values(schema)) {
      const config = getTableConfig(table);
      const columns = await env.DB.prepare(`PRAGMA table_info("${config.name}")`).all<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
        dflt_value: string | null;
      }>();
      expect(
        columns.results.map((column) => ({
          name: column.name,
          type: column.type.toLowerCase(),
          // SQLite TEXT PRIMARY KEY reports notnull=0; Drizzle models the
          // application key as non-null. Compare primary-key identity separately.
          notNull: Boolean(column.notnull || column.pk),
          primary: Boolean(column.pk),
          default: column.dflt_value,
        })),
      ).toEqual(
        config.columns.map((column) => ({
          name: column.name,
          type: column.getSQLType(),
          notNull: column.notNull,
          primary: column.primary,
          default:
            column.default === undefined
              ? null
              : typeof column.default === "string"
                ? `'${column.default}'`
                : String(column.default),
        })),
      );
      const foreignKeys = await env.DB.prepare(`PRAGMA foreign_key_list("${config.name}")`).all<{
        from: string;
        to: string;
        table: string;
        on_delete: string;
        on_update: string;
      }>();
      const keySignature = (key: {
        from: string;
        to: string;
        table: string;
        on_delete: string;
        on_update: string;
      }) =>
        `${key.from}:${key.table}.${key.to}:${key.on_delete.toLowerCase()}:${key.on_update.toLowerCase()}`;
      expect(foreignKeys.results.map(keySignature).sort()).toEqual(
        config.foreignKeys
          .flatMap((key) => {
            const reference = key.reference();
            return reference.columns.map((column, index) =>
              keySignature({
                from: column.name,
                to: reference.foreignColumns[index]?.name ?? "",
                table: getTableName(reference.foreignTable),
                on_delete: key.onDelete ?? "no action",
                on_update: key.onUpdate ?? "no action",
              }),
            );
          })
          .sort(),
      );
      const definition = await env.DB.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
        .bind(config.name)
        .first<{ sql: string }>();
      const normalizedDefinition = normalize(definition?.sql ?? "");
      expect(normalizedDefinition.match(/check\(/g) ?? []).toHaveLength(config.checks.length);
      for (const constraint of config.checks) {
        expect(normalizedDefinition).toContain(
          `check(${normalize(dialect.sqlToQuery(constraint.value).sql)})`,
        );
      }
      const indexes = await env.DB.prepare(`PRAGMA index_list("${config.name}")`).all<{
        name: string;
        unique: number;
        origin: string;
        partial: number;
      }>();
      expect(
        indexes.results
          .filter((index) => index.origin === "c")
          .map((index) => index.name)
          .sort(),
      ).toEqual(config.indexes.map((index) => index.config.name).sort());
      for (const { config: index } of config.indexes) {
        const definition = await env.DB.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
        )
          .bind(index.name)
          .first<{ sql: string }>();
        const indexSql = normalize(definition?.sql ?? "");
        const columnsSql = index.columns
          .map((column) => normalize(dialect.sqlToQuery(sql`${column}`).sql))
          .join(",");
        expect(indexSql).toContain(`on${config.name}(${columnsSql})`);
        expect(indexes.results.find((item) => item.name === index.name)).toMatchObject({
          unique: Number(index.unique),
          partial: Number(Boolean(index.where)),
        });
        if (index.where)
          expect(indexSql).toContain(`where${normalize(dialect.sqlToQuery(index.where).sql)}`);
      }
      const uniqueColumns = [];
      for (const index of indexes.results.filter((item) => item.origin === "u")) {
        const columns = await env.DB.prepare(`PRAGMA index_info("${index.name}")`).all<{
          name: string;
        }>();
        uniqueColumns.push(columns.results.map((column) => column.name).join(","));
      }
      expect(uniqueColumns.sort()).toEqual(
        [
          ...config.columns.filter((column) => column.isUnique).map((column) => column.name),
          ...config.uniqueConstraints.map((constraint) =>
            constraint.columns.map((column) => column.name).join(","),
          ),
        ].sort(),
      );
    }
  });

  it("uses Drizzle for owner-scoped Project CRUD and message reads", async () => {
    const projects = new D1ProjectRepository(env.DB);
    const messages = new D1MessageRepository(env.DB);
    const created = await projects.create({
      id: "project_2",
      userId: "user_1",
      title: "Second",
      defaultAgentRuntimeId: "pi",
      now: finishedAt,
    });
    expect(await projects.findOwnedById("project_2", "user_1")).toEqual(created);
    expect(await projects.findOwnedById("project_2", "other_user")).toBeNull();
    expect(
      await projects.renameOwned({
        projectId: "project_2",
        userId: "other_user",
        title: "Wrong",
        updatedAt: createdAt,
      }),
    ).toBeNull();
    expect((await projects.listOwned("user_1")).map((project) => project.id)).toEqual([
      "project_2",
      "project_1",
    ]);
    expect(await projects.listOwned("other_user")).toEqual([]);
    await createRunningRun(new D1AgentRunRepository(env.DB));
    const input = await messages.findById("message_user_1", "project_1");
    expect(input).toMatchObject({ content: "Create a file", role: "user", sequence: 0 });
    expect(await messages.findById("message_user_1", "project_2")).toBeNull();
    expect(await messages.listByProjectId("project_1")).toEqual([input]);
    expect(await messages.listByProjectId("project_2")).toEqual([]);
  });

  it("bounds context reads and excludes the current input and later messages", async () => {
    await env.DB.batch(
      Array.from({ length: 24 }, (_, sequence) =>
        env.DB.prepare(
          `INSERT INTO messages (id, project_id, agent_run_id, sequence, role, content, created_at)
       VALUES (?, 'project_1', NULL, ?, 'user', ?, ?)`,
        ).bind(
          `history_${sequence}`,
          sequence,
          sequence === 22 ? "x".repeat(70_000) : String(sequence),
          createdAt,
        ),
      ),
    );
    const repository = new D1MessageRepository(env.DB);
    const history = await repository.listContextBefore("project_1", 23);
    expect(history).toHaveLength(21);
    expect(history.map((item) => item.sequence)).toEqual(
      Array.from({ length: 21 }, (_, i) => 22 - i),
    );
    expect(history[0]?.content).toBeNull();
    await env.DB.prepare("UPDATE messages SET content = ? WHERE id = 'history_21'")
      .bind("before\u0000after")
      .run();
    expect((await repository.listContextBefore("project_1", 22))[0]?.content).toBe(
      "before\u0000after",
    );
    expect(await repository.listContextBefore("other_project", 23)).toEqual([]);
  });

  it("updates a running Run lease only from its expected snapshot", async () => {
    await createRunningRun(new D1AgentRunRepository(env.DB));
    const leases = new D1SandboxLeaseRepository(env.DB);
    const updated = await leases.updateStateForRun({
      leaseId: "lease_1",
      runId: "run_1",
      expectedProviderRef: null,
      expectedUpdatedAt: createdAt,
      providerRef: "provider_1",
      status: "busy",
      updatedAt: finishedAt,
    });
    expect(updated).toMatchObject({
      providerRef: "provider_1",
      status: "busy",
      updatedAt: finishedAt,
    });
    expect(await leases.findByProjectId("project_1")).toEqual(updated);
  });

  it("rejects a terminal Run write even when a later Run reuses the same provider and snapshot", async () => {
    const runs = new D1AgentRunRepository(env.DB);
    const leases = new D1SandboxLeaseRepository(env.DB);
    await createRunningRun(runs);
    await leases.updateState({
      leaseId: "lease_1",
      providerRef: "provider_1",
      status: "busy",
      updatedAt: createdAt,
    });
    await runs.transition({
      from: "running",
      to: "interrupted",
      runId: "run_1",
      finishedAt,
      failureCode: "run.interrupted",
    });
    await createRunningRun(runs, "run_2");
    await seedRunningPreview();
    const before = await leases.findByProjectId("project_1");
    const result = await leases.updateStateForRun({
      leaseId: "lease_1",
      runId: "run_1",
      expectedProviderRef: "provider_1",
      expectedUpdatedAt: createdAt,
      providerRef: null,
      status: "stopped",
      updatedAt: finishedAt,
    });
    expect(result).toBeNull();
    expect(await leases.findByProjectId("project_1")).toEqual(before);
    expect((await runs.findById("run_2"))?.status).toBe("running");
    expect(
      await env.DB.prepare("SELECT id FROM preview_sessions WHERE id = 'preview_1'").first(),
    ).toEqual({ id: "preview_1" });
  });

  it.each([
    { expectedProviderRef: "wrong_provider", expectedUpdatedAt: createdAt },
    { expectedProviderRef: "provider_1", expectedUpdatedAt: finishedAt },
  ])("rejects a stale snapshot without deleting the active Preview: %j", async (snapshot) => {
    await createRunningRun(new D1AgentRunRepository(env.DB));
    const leases = new D1SandboxLeaseRepository(env.DB);
    await leases.updateState({
      leaseId: "lease_1",
      providerRef: "provider_1",
      status: "busy",
      updatedAt: createdAt,
    });
    await seedRunningPreview();
    const before = await leases.findByProjectId("project_1");
    expect(
      await leases.updateStateForRun({
        leaseId: "lease_1",
        runId: "run_1",
        ...snapshot,
        providerRef: null,
        status: "stopped",
        updatedAt: finishedAt,
      }),
    ).toBeNull();
    expect(await leases.findByProjectId("project_1")).toEqual(before);
    expect(
      await env.DB.prepare(
        "SELECT id, status FROM preview_sessions WHERE id = 'preview_1'",
      ).first(),
    ).toEqual({ id: "preview_1", status: "running" });
  });

  it("deletes Preview in the same D1 batch only after a successful Run lease stop", async () => {
    await createRunningRun(new D1AgentRunRepository(env.DB));
    const leases = new D1SandboxLeaseRepository(env.DB);
    await leases.updateState({
      leaseId: "lease_1",
      providerRef: "provider_1",
      status: "busy",
      updatedAt: createdAt,
    });
    await seedRunningPreview();
    expect(
      await leases.updateStateForRun({
        leaseId: "lease_1",
        runId: "run_1",
        expectedProviderRef: "provider_1",
        expectedUpdatedAt: createdAt,
        providerRef: null,
        status: "stopped",
        updatedAt: finishedAt,
      }),
    ).toMatchObject({ providerRef: null, status: "stopped", updatedAt: finishedAt });
    expect(
      await env.DB.prepare("SELECT id FROM preview_sessions WHERE id = 'preview_1'").first(),
    ).toBeNull();
    expect(await leases.findByProjectId("project_1")).toMatchObject({
      providerRef: null,
      status: "stopped",
    });
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

async function createRunningRun(repository: D1AgentRunRepository, runId = "run_1") {
  const created = await repository.createQueuedWithInput({
    agentRunId: runId,
    agentRuntimeId: "pi",
    content: "Create a file",
    inputMessageId: runId === "run_1" ? "message_user_1" : `message_user_${runId}`,
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
    runId,
    startedAt: createdAt,
    to: "starting",
  });
  await repository.transition({
    from: "starting",
    runId,
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

async function seedRunningPreview() {
  await env.DB.prepare(`INSERT INTO preview_sessions (
    id, project_id, sandbox_lease_id, provider_sandbox_ref, provider_process_ref,
    status, port, expires_at, created_at, updated_at
  ) VALUES ('preview_1', 'project_1', 'lease_1', 'provider_1', 'process_1',
    'running', 3000, '2026-07-27T00:30:00.000Z', ?, ?)`)
    .bind(createdAt, createdAt)
    .run();
}
