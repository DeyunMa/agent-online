import type {
  AgentRunRecord,
  AgentRunRepository,
  AgentRunUsageDelta,
  CreateQueuedAgentRunResult,
} from "../../application/ports";
import type { AgentRuntimeId } from "../../agent/contract";
import {
  canTransitionAgentRun,
  isTerminalAgentRun,
  type AgentRunStatus,
} from "../../domain/agent-run";
import type { RuntimeKind } from "../../runtime/contract";
import {
  type AgentRunRow,
  type MessageRow,
  agentRunColumns,
  messageColumns,
  requireBatchRow,
  toAgentRunRecord,
  toMessageRecord,
} from "./d1-records";

export class D1AgentRunRepository implements AgentRunRepository {
  constructor(private readonly db: D1Database) {}

  async createQueuedWithInput(input: {
    agentRunId: string;
    agentRuntimeId: AgentRuntimeId;
    content: string;
    inputMessageId: string;
    modelId: string;
    now: string;
    projectId: string;
    sandboxLeaseId: string;
    sandboxRuntimeId: RuntimeKind;
    userId: string;
  }): Promise<CreateQueuedAgentRunResult> {
    try {
      const results = await this.db.batch<Record<string, unknown>>([
        this.db
          .prepare(
            `INSERT INTO messages (
              id,
              project_id,
              agent_run_id,
              sequence,
              role,
              content,
              created_at
            ) VALUES (?, ?, NULL, COALESCE((SELECT MAX(sequence) + 1 FROM messages WHERE project_id = ?), 0), 'user', ?, ?)`,
          )
          .bind(input.inputMessageId, input.projectId, input.projectId, input.content, input.now),
        this.db
          .prepare(
            `INSERT INTO agent_runs (
              id,
              user_id,
              project_id,
              input_message_id,
              sandbox_lease_id,
              agent_runtime_id,
              sandbox_runtime_id,
              model_id,
              status,
              input_tokens,
              output_tokens,
              total_tokens,
              model_request_count,
              provider_process_ref,
              sandbox_duration_ms,
              failure_reason,
              created_at,
              started_at,
              finished_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, 0, 0, NULL, 0, NULL, ?, NULL, NULL)`,
          )
          .bind(
            input.agentRunId,
            input.userId,
            input.projectId,
            input.inputMessageId,
            input.sandboxLeaseId,
            input.agentRuntimeId,
            input.sandboxRuntimeId,
            input.modelId,
            input.now,
          ),
        this.db
          .prepare(`SELECT ${messageColumns} FROM messages WHERE id = ? AND project_id = ? LIMIT 1`)
          .bind(input.inputMessageId, input.projectId),
        this.db
          .prepare(`SELECT ${agentRunColumns} FROM agent_runs WHERE id = ? LIMIT 1`)
          .bind(input.agentRunId),
      ]);

      return {
        inputMessage: toMessageRecord(
          requireBatchRow<MessageRow>(results, 2, "create queued AgentRun message"),
        ),
        kind: "created",
        run: toAgentRunRecord(requireBatchRow<AgentRunRow>(results, 3, "create queued AgentRun")),
      };
    } catch (error) {
      if (isActiveAgentRunConflict(error)) {
        return { kind: "project_busy" };
      }

      throw error;
    }
  }

  async findOwnedById(agentRunId: string, userId: string): Promise<AgentRunRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${agentRunColumns} FROM agent_runs WHERE id = ? AND user_id = ? LIMIT 1`)
      .bind(agentRunId, userId)
      .first<AgentRunRow>();

    return row === null ? null : toAgentRunRecord(row);
  }

  async findById(agentRunId: string): Promise<AgentRunRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${agentRunColumns} FROM agent_runs WHERE id = ? LIMIT 1`)
      .bind(agentRunId)
      .first<AgentRunRow>();

    return row === null ? null : toAgentRunRecord(row);
  }

  async findActiveByProjectId(projectId: string): Promise<AgentRunRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT ${agentRunColumns}
        FROM agent_runs
        WHERE project_id = ?
          AND status IN ('queued', 'starting', 'running', 'cancelling')
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      )
      .bind(projectId)
      .first<AgentRunRow>();

    return row === null ? null : toAgentRunRecord(row);
  }

  async findActiveOwnedByProjectId(
    projectId: string,
    userId: string,
  ): Promise<AgentRunRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT ${agentRunColumns}
        FROM agent_runs
        WHERE project_id = ?
          AND user_id = ?
          AND status IN ('queued', 'starting', 'running', 'cancelling')
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      )
      .bind(projectId, userId)
      .first<AgentRunRow>();

    return row === null ? null : toAgentRunRecord(row);
  }

  async listRecentOwnedByProjectId(projectId: string, userId: string): Promise<AgentRunRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT ${agentRunColumns}
        FROM agent_runs
        WHERE project_id = ? AND user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 50`,
      )
      .bind(projectId, userId)
      .all<AgentRunRow>();

    return result.results.map(toAgentRunRecord);
  }

  async setProviderProcessRef(runId: string, providerProcessRef: string) {
    if (!providerProcessRef || providerProcessRef.length > 512) {
      throw new Error("AgentRun provider process reference is invalid");
    }

    const results = await this.db.batch<AgentRunRow>([
      this.db
        .prepare(
          `UPDATE agent_runs
          SET provider_process_ref = ?
          WHERE id = ?
            AND status IN ('starting', 'running', 'cancelling')`,
        )
        .bind(providerProcessRef, runId),
      this.db.prepare(`SELECT ${agentRunColumns} FROM agent_runs WHERE id = ? LIMIT 1`).bind(runId),
    ]);

    if (results[0]?.meta.changes !== 1) {
      return null;
    }

    return toAgentRunRecord(
      requireBatchRow<AgentRunRow>(results, 1, "set AgentRun process reference"),
    );
  }

  async setSandboxDuration(runId: string, sandboxDurationMs: number) {
    if (!Number.isSafeInteger(sandboxDurationMs) || sandboxDurationMs < 0) {
      throw new Error("AgentRun sandbox duration must be a non-negative safe integer");
    }

    const results = await this.db.batch<AgentRunRow>([
      this.db
        .prepare(
          `UPDATE agent_runs
          SET sandbox_duration_ms = MAX(sandbox_duration_ms, ?)
          WHERE id = ?
            AND status IN ('queued', 'starting', 'running', 'cancelling')`,
        )
        .bind(sandboxDurationMs, runId),
      this.db.prepare(`SELECT ${agentRunColumns} FROM agent_runs WHERE id = ? LIMIT 1`).bind(runId),
    ]);

    if (results[0]?.meta.changes !== 1) {
      return null;
    }

    return toAgentRunRecord(
      requireBatchRow<AgentRunRow>(results, 1, "set AgentRun sandbox duration"),
    );
  }

  async addUsageDelta(runId: string, usage: AgentRunUsageDelta): Promise<AgentRunRecord | null> {
    assertUsageDelta(usage);

    const results = await this.db.batch<AgentRunRow>([
      this.db
        .prepare(
          `UPDATE agent_runs
          SET input_tokens = input_tokens + ?,
              output_tokens = output_tokens + ?,
              total_tokens = total_tokens + ?,
              model_request_count = model_request_count + ?,
              sandbox_duration_ms = sandbox_duration_ms + ?
          WHERE id = ?
            AND status IN ('queued', 'starting', 'running', 'cancelling')`,
        )
        .bind(
          usage.inputTokens,
          usage.outputTokens,
          usage.totalTokens,
          usage.modelRequestCount,
          usage.sandboxDurationMs,
          runId,
        ),
      this.db.prepare(`SELECT ${agentRunColumns} FROM agent_runs WHERE id = ? LIMIT 1`).bind(runId),
    ]);

    if (results[0]?.meta.changes !== 1) {
      return null;
    }

    return toAgentRunRecord(requireBatchRow<AgentRunRow>(results, 1, "add AgentRun usage delta"));
  }

  async completeSucceeded(input: {
    assistantMessage: {
      content: string;
      id: string;
    } | null;
    finishedAt: string;
    runId: string;
    sandboxDurationMs: number;
  }): Promise<AgentRunRecord | null> {
    if (!Number.isSafeInteger(input.sandboxDurationMs) || input.sandboxDurationMs < 0) {
      throw new Error("AgentRun sandbox duration must be a non-negative safe integer");
    }
    if (
      input.assistantMessage &&
      (!input.assistantMessage.content.trim() || !input.assistantMessage.id)
    ) {
      throw new Error("AgentRun assistant Message is invalid");
    }

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE agent_runs
          SET status = 'succeeded',
              sandbox_duration_ms = MAX(sandbox_duration_ms, ?),
              failure_reason = NULL,
              provider_process_ref = NULL,
              finished_at = ?
          WHERE id = ?
            AND status = 'running'`,
        )
        .bind(input.sandboxDurationMs, input.finishedAt, input.runId),
    ];

    if (input.assistantMessage) {
      statements.push(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO messages (
              id,
              project_id,
              agent_run_id,
              sequence,
              role,
              content,
              created_at
            )
            SELECT
              ?,
              agent_runs.project_id,
              agent_runs.id,
              COALESCE((
                SELECT MAX(sequence) + 1
                FROM messages
                WHERE project_id = agent_runs.project_id
              ), 0),
              'assistant',
              ?,
              ?
            FROM agent_runs
            WHERE agent_runs.id = ?
              AND agent_runs.status = 'succeeded'
              AND agent_runs.finished_at = ?`,
          )
          .bind(
            input.assistantMessage.id,
            input.assistantMessage.content,
            input.finishedAt,
            input.runId,
            input.finishedAt,
          ),
      );
    }

    statements.push(
      this.db
        .prepare(
          `UPDATE projects
          SET updated_at = ?
          WHERE id = (
            SELECT project_id
            FROM agent_runs
            WHERE id = ?
              AND status = 'succeeded'
              AND finished_at = ?
          )`,
        )
        .bind(input.finishedAt, input.runId, input.finishedAt),
      this.db
        .prepare(
          `SELECT ${agentRunColumns}
          FROM agent_runs
          WHERE id = ?
          LIMIT 1`,
        )
        .bind(input.runId),
    );

    const results = await this.db.batch<AgentRunRow>(statements);
    if (results[0]?.meta.changes !== 1) {
      return null;
    }

    return toAgentRunRecord(
      requireBatchRow<AgentRunRow>(results, results.length - 1, "complete AgentRun successfully"),
    );
  }

  async transition(input: {
    failureReason?: string | null;
    finishedAt?: string | null;
    from: AgentRunStatus;
    runId: string;
    startedAt?: string | null;
    to: AgentRunStatus;
  }): Promise<AgentRunRecord | null> {
    if (!canTransitionAgentRun(input.from, input.to)) {
      throw new Error(`Invalid AgentRun transition from ${input.from} to ${input.to}`);
    }

    const assignments = ["status = ?"];
    const values: unknown[] = [input.to];

    if (input.failureReason !== undefined) {
      assignments.push("failure_reason = ?");
      values.push(input.failureReason);
    }

    if (input.startedAt !== undefined) {
      assignments.push("started_at = ?");
      values.push(input.startedAt);
    }

    if (input.finishedAt !== undefined) {
      assignments.push("finished_at = ?");
      values.push(input.finishedAt);
    }

    if (isTerminalAgentRun(input.to)) {
      assignments.push("provider_process_ref = NULL");
    }

    values.push(input.runId, input.from);

    const results = await this.db.batch<AgentRunRow>([
      this.db
        .prepare(`UPDATE agent_runs SET ${assignments.join(", ")} WHERE id = ? AND status = ?`)
        .bind(...values),
      this.db
        .prepare(`SELECT ${agentRunColumns} FROM agent_runs WHERE id = ? LIMIT 1`)
        .bind(input.runId),
    ]);

    if (results[0]?.meta.changes !== 1) {
      return null;
    }

    return toAgentRunRecord(requireBatchRow<AgentRunRow>(results, 1, "transition AgentRun"));
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = "cause" in error ? error.cause : undefined;
    return `${error.message} ${cause === undefined ? "" : errorText(cause)}`.toLowerCase();
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message).toLowerCase();
  }

  return String(error).toLowerCase();
}

function isActiveAgentRunConflict(error: unknown): boolean {
  const text = errorText(error);

  return (
    text.includes("project_preview_starting") ||
    text.includes("project_terminal_active") ||
    ((text.includes("agent_runs.project_id") ||
      text.includes("agent_runs_one_active_per_project")) &&
      (text.includes("unique") || text.includes("constraint")))
  );
}

function assertUsageDelta(usage: AgentRunUsageDelta) {
  for (const value of Object.values(usage)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("AgentRun usage deltas must be non-negative safe integers");
    }
  }
}
