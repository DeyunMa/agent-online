import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  D1AgentRunRepository,
  D1ProjectRepository,
  D1SandboxLeaseRepository,
} from "./d1-repositories";
import { D1TerminalSessionRepository } from "./d1-terminal-session-repository";
import { D1ModelAdmission } from "./d1-model-admission";

const at = "2026-09-20T00:00:00.000Z";
const runs = new D1AgentRunRepository(env.DB);
const terminals = new D1TerminalSessionRepository(env.DB);
const models = new D1ModelAdmission(env.DB);
let userId: string;

beforeEach(async () => {
  userId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Test', ?, 1, ?, ?)`,
  )
    .bind(userId, `${userId}@example.com`, at, at)
    .run();
});

async function project(owner = userId) {
  const id = crypto.randomUUID();
  await new D1ProjectRepository(env.DB).create({
    id,
    userId: owner,
    title: "Resource fixture",
    defaultAgentRuntimeId: "pi",
    now: at,
  });
  const lease = await new D1SandboxLeaseRepository(env.DB).getOrCreate({
    id: crypto.randomUUID(),
    now: at,
    projectId: id,
    runtimeId: "fake",
  });
  return { id, lease, userId: owner };
}
async function queue(target: Awaited<ReturnType<typeof project>>) {
  return runs.createQueuedWithInput({
    agentRunId: crypto.randomUUID(),
    agentRuntimeId: "pi",
    content: "test",
    inputMessageId: crypto.randomUUID(),
    modelId: "test-model",
    now: at,
    projectId: target.id,
    sandboxLeaseId: target.lease.id,
    sandboxRuntimeId: "fake",
    userId: target.userId,
  });
}
async function terminal(target: Awaited<ReturnType<typeof project>>) {
  return terminals.claim({
    id: crypto.randomUUID(),
    projectId: target.id,
    sandboxLeaseId: target.lease.id,
    now: at,
    expiresAt: at,
    expectedLeaseProviderRef: null,
    expectedLeaseUpdatedAt: target.lease.updatedAt,
  });
}
async function running() {
  const created = await queue(await project());
  if (created.kind !== "created") throw new Error("Fixture Run not created");
  await runs.transition({ runId: created.run.id, from: "queued", to: "starting", startedAt: at });
  await runs.transition({ runId: created.run.id, from: "starting", to: "running" });
  return created.run.id;
}

describe("atomic user resource admission", () => {
  it("admits at most two simultaneous Run/Terminal claims across Projects and rolls back rejected input", async () => {
    const targets = await Promise.all([project(), project(), project()]);
    const [a, b, c] = targets;
    if (!a || !b || !c) throw new Error("Missing fixture");
    const results = await Promise.all([queue(a), queue(b), terminal(c)]);
    expect(results.filter((result) => result.kind === "resource_limited")).toHaveLength(1);
    expect(
      results.filter((result) => result.kind === "created" || result.kind === "claimed"),
    ).toHaveLength(2);
    const messages = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM messages JOIN projects ON projects.id = messages.project_id WHERE projects.user_id = ?`,
    )
      .bind(userId)
      .first<{ count: number }>();
    expect(messages?.count).toBe(results.filter((result) => result.kind === "created").length);
    const counters = await env.DB.prepare(
      "SELECT admission_count FROM user_resource_counters WHERE user_id = ?",
    )
      .bind(userId)
      .first<{ admission_count: number }>();
    expect(counters?.admission_count).toBe(2);
  });

  it("counts expired Terminal hard locks until explicit release and isolates users", async () => {
    const a = await terminal(await project());
    const b = await terminal(await project());
    expect(a.kind).toBe("claimed");
    expect(b.kind).toBe("claimed");
    const target = await project();
    expect((await queue(target)).kind).toBe("resource_limited");
    const other = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Other', ?, 1, ?, ?)`,
    )
      .bind(other, `${other}@example.com`, at, at)
      .run();
    expect((await queue(await project(other))).kind).toBe("created");
    if (a.kind !== "claimed") throw new Error("Missing Terminal");
    await terminals.release(a.session.id);
    expect((await queue(target)).kind).toBe("created");
  });

  it("shares the hourly allowance across Run and Terminal, survives Project deletion and rolls over", async () => {
    await env.DB.prepare(
      `INSERT INTO user_resource_counters (user_id, admission_hour, admission_count) VALUES (?, CAST(strftime('%s', 'now') AS INTEGER) / 3600, 59)`,
    )
      .bind(userId)
      .run();
    const target = await project();
    const last = await terminal(target);
    expect(last.kind).toBe("claimed");
    if (last.kind !== "claimed") throw new Error("Missing Terminal");
    await terminals.release(last.session.id);
    expect((await terminal(target)).kind).toBe("resource_limited");
    expect(await terminals.findByProjectId(target.id)).toBeNull();
    expect((await queue(target)).kind).toBe("resource_limited");
    const messages = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE project_id = ?",
    )
      .bind(target.id)
      .first<{ count: number }>();
    expect(messages?.count).toBe(0);
    await env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(target.id).run();
    const next = await project();
    expect((await queue(next)).kind).toBe("resource_limited");
    await env.DB.prepare(
      "UPDATE user_resource_counters SET admission_hour = admission_hour - 1 WHERE user_id = ?",
    )
      .bind(userId)
      .run();
    expect((await queue(next)).kind).toBe("created");
  });

  it("atomically admits one model request and consumes at most 64 per Run", async () => {
    const id = await running();
    const raced = await Promise.all([models.acquire(id), models.acquire(id), models.acquire(id)]);
    expect(raced.filter(Boolean)).toHaveLength(1);
    await models.release(id);
    for (let i = 1; i < 64; i += 1) {
      expect(await models.acquire(id)).toBe(true);
      await models.release(id);
    }
    expect(await models.acquire(id)).toBe(false);
    expect((await runs.findById(id))?.usage.modelRequestCount).toBe(0);
    const counters = await env.DB.prepare(
      "SELECT model_count FROM user_resource_counters WHERE user_id = ?",
    )
      .bind(userId)
      .first<{ model_count: number }>();
    expect(counters?.model_count).toBe(64);
  });

  it("shares the daily model budget across Runs and rolls back rejected reservations", async () => {
    const first = await running();
    const second = await running();
    await env.DB.prepare(
      `UPDATE user_resource_counters SET model_day = CAST(strftime('%s', 'now') AS INTEGER) / 86400, model_count = 511 WHERE user_id = ?`,
    )
      .bind(userId)
      .run();
    const admitted = await Promise.all([models.acquire(first), models.acquire(second)]);
    expect(admitted.filter(Boolean)).toHaveLength(1);
    const denied = admitted[0] ? second : first;
    const deniedRow = await env.DB.prepare(
      "SELECT model_admission_count, model_request_active FROM agent_runs WHERE id = ?",
    )
      .bind(denied)
      .first();
    expect(deniedRow).toEqual({ model_admission_count: 0, model_request_active: 0 });
    await env.DB.prepare(
      "UPDATE user_resource_counters SET model_day = model_day - 1 WHERE user_id = ?",
    )
      .bind(userId)
      .run();
    expect(await models.acquire(denied)).toBe(true);
  });

  it("stops forwarding after the recorded token threshold or Run cancellation", async () => {
    const id = await running();
    await runs.addUsageDelta(id, {
      inputTokens: 499999,
      outputTokens: 0,
      totalTokens: 499999,
      modelRequestCount: 1,
      sandboxDurationMs: 0,
    });
    expect(await models.acquire(id)).toBe(true);
    await runs.addUsageDelta(id, {
      inputTokens: 1,
      outputTokens: 0,
      totalTokens: 1,
      modelRequestCount: 1,
      sandboxDurationMs: 0,
    });
    await models.release(id);
    expect(await models.acquire(id)).toBe(false);
    const second = await running();
    await runs.transition({ runId: second, from: "running", to: "cancelling" });
    expect(await models.acquire(second)).toBe(false);
    expect(await models.acquire("missing")).toBe(false);
  });
});
