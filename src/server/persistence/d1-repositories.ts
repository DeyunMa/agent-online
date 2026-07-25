import type {
  AgentRunRecord,
  AgentRunRepository,
  AgentRunUsage,
  CreateQueuedAgentRunResult,
  MessageRecord,
  MessageRepository,
  ProjectRecord,
  ProjectRepository,
  SandboxLeaseRecord,
  SandboxLeaseRepository,
} from "../../application/ports";
import type { AgentRuntimeId } from "../../agent/contract";
import type { AgentRunStatus } from "../../domain/agent-run";
import type { SandboxLeaseStatus } from "../../domain/sandbox-lease";
import type { RuntimeKind } from "../../runtime/contract";

type ProjectRow = {
  created_at: string;
  default_agent_runtime_id: AgentRuntimeId;
  id: string;
  title: string;
  updated_at: string;
  user_id: string;
};

type SandboxLeaseRow = {
  created_at: string;
  id: string;
  project_id: string;
  provider_ref: string | null;
  sandbox_runtime_id: RuntimeKind;
  status: SandboxLeaseStatus;
  updated_at: string;
};

type AgentRunRow = {
  agent_runtime_id: AgentRuntimeId;
  created_at: string;
  failure_reason: string | null;
  finished_at: string | null;
  id: string;
  input_message_id: string | null;
  input_tokens: number;
  model_id: string;
  model_request_count: number;
  output_tokens: number;
  project_id: string;
  sandbox_duration_ms: number;
  sandbox_lease_id: string;
  sandbox_runtime_id: RuntimeKind;
  started_at: string | null;
  status: AgentRunStatus;
  total_tokens: number;
  user_id: string;
};

type MessageRow = {
  agent_run_id: string | null;
  content: string;
  created_at: string;
  id: string;
  project_id: string;
  role: "user" | "assistant";
  sequence: number;
};

const projectColumns = `
  id,
  user_id,
  title,
  default_agent_runtime_id,
  created_at,
  updated_at
`;

const sandboxLeaseColumns = `
  id,
  project_id,
  sandbox_runtime_id,
  provider_ref,
  status,
  created_at,
  updated_at
`;

const agentRunColumns = `
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
  sandbox_duration_ms,
  failure_reason,
  created_at,
  started_at,
  finished_at
`;

const messageColumns = `
  id,
  project_id,
  agent_run_id,
  sequence,
  role,
  content,
  created_at
`;

function toProjectRecord(row: ProjectRow): ProjectRecord {
  return {
    createdAt: row.created_at,
    defaultAgentRuntimeId: row.default_agent_runtime_id,
    id: row.id,
    title: row.title,
    updatedAt: row.updated_at,
    userId: row.user_id,
  };
}

function toSandboxLeaseRecord(row: SandboxLeaseRow): SandboxLeaseRecord {
  return {
    createdAt: row.created_at,
    id: row.id,
    projectId: row.project_id,
    providerRef: row.provider_ref,
    runtimeId: row.sandbox_runtime_id,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

function toAgentRunRecord(row: AgentRunRow): AgentRunRecord {
  return {
    agentRuntimeId: row.agent_runtime_id,
    createdAt: row.created_at,
    failureReason: row.failure_reason,
    finishedAt: row.finished_at,
    id: row.id,
    inputMessageId: row.input_message_id,
    modelId: row.model_id,
    projectId: row.project_id,
    sandboxLeaseId: row.sandbox_lease_id,
    sandboxRuntimeId: row.sandbox_runtime_id,
    startedAt: row.started_at,
    status: row.status,
    usage: {
      inputTokens: row.input_tokens,
      modelRequestCount: row.model_request_count,
      outputTokens: row.output_tokens,
      sandboxDurationMs: row.sandbox_duration_ms,
      totalTokens: row.total_tokens,
    },
    userId: row.user_id,
  };
}

function toMessageRecord(row: MessageRow): MessageRecord {
  return {
    agentRunId: row.agent_run_id,
    content: row.content,
    createdAt: row.created_at,
    id: row.id,
    projectId: row.project_id,
    role: row.role,
    sequence: row.sequence,
  };
}

function requireRow<T>(row: T | null | undefined, operation: string): T {
  if (row === null || row === undefined) {
    throw new Error(`D1 ${operation} did not return a row`);
  }

  return row;
}

function requireBatchRow<T>(results: readonly { results: unknown[] }[], index: number, operation: string): T {
  return requireRow(results[index]?.results[0] as T | undefined, operation);
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
    (text.includes("agent_runs.project_id") || text.includes("agent_runs_one_active_per_project")) &&
    (text.includes("unique") || text.includes("constraint"))
  );
}

export class D1ProjectRepository implements ProjectRepository {
  constructor(private readonly db: D1Database) {}

  async create(input: Omit<ProjectRecord, "createdAt" | "updatedAt"> & { now: string }): Promise<ProjectRecord> {
    await this.db
      .prepare(
        `INSERT INTO projects (
          id,
          user_id,
          title,
          default_agent_runtime_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.userId,
        input.title,
        input.defaultAgentRuntimeId,
        input.now,
        input.now,
      )
      .run();

    return {
      createdAt: input.now,
      defaultAgentRuntimeId: input.defaultAgentRuntimeId,
      id: input.id,
      title: input.title,
      updatedAt: input.now,
      userId: input.userId,
    };
  }

  async deleteOwned(projectId: string, userId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM projects WHERE id = ? AND user_id = ?")
      .bind(projectId, userId)
      .run();

    return result.meta.changes > 0;
  }

  async findOwnedById(projectId: string, userId: string): Promise<ProjectRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${projectColumns} FROM projects WHERE id = ? AND user_id = ? LIMIT 1`)
      .bind(projectId, userId)
      .first<ProjectRow>();

    return row === null ? null : toProjectRecord(row);
  }

  async listOwned(userId: string): Promise<ProjectRecord[]> {
    const result = await this.db
      .prepare(`SELECT ${projectColumns} FROM projects WHERE user_id = ? ORDER BY updated_at DESC, id DESC`)
      .bind(userId)
      .all<ProjectRow>();

    return result.results.map(toProjectRecord);
  }
}

export class D1MessageRepository implements MessageRepository {
  constructor(private readonly db: D1Database) {}

  async listByProjectId(projectId: string): Promise<MessageRecord[]> {
    const result = await this.db
      .prepare(`SELECT ${messageColumns} FROM messages WHERE project_id = ? ORDER BY sequence ASC`)
      .bind(projectId)
      .all<MessageRow>();

    return result.results.map(toMessageRecord);
  }
}

export class D1SandboxLeaseRepository implements SandboxLeaseRepository {
  constructor(private readonly db: D1Database) {}

  async findByProjectId(projectId: string): Promise<SandboxLeaseRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${sandboxLeaseColumns} FROM sandbox_leases WHERE project_id = ? LIMIT 1`)
      .bind(projectId)
      .first<SandboxLeaseRow>();

    return row === null ? null : toSandboxLeaseRecord(row);
  }

  async getOrCreate(input: {
    id: string;
    now: string;
    projectId: string;
    runtimeId: RuntimeKind;
  }): Promise<SandboxLeaseRecord> {
    const results = await this.db.batch<SandboxLeaseRow>([
      this.db
        .prepare(
          `INSERT INTO sandbox_leases (
            id,
            project_id,
            sandbox_runtime_id,
            provider_ref,
            status,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, NULL, 'stopped', ?, ?)
          ON CONFLICT(project_id) DO NOTHING`,
        )
        .bind(input.id, input.projectId, input.runtimeId, input.now, input.now),
      this.db
        .prepare(`SELECT ${sandboxLeaseColumns} FROM sandbox_leases WHERE project_id = ? LIMIT 1`)
        .bind(input.projectId),
    ]);

    return toSandboxLeaseRecord(requireBatchRow<SandboxLeaseRow>(results, 1, "getOrCreate sandbox lease"));
  }

  async updateState(input: {
    providerRef: string | null;
    status: SandboxLeaseStatus;
    updatedAt: string;
    leaseId: string;
  }): Promise<SandboxLeaseRecord> {
    const results = await this.db.batch<SandboxLeaseRow>([
      this.db
        .prepare(
          `UPDATE sandbox_leases
          SET provider_ref = ?, status = ?, updated_at = ?
          WHERE id = ?`,
        )
        .bind(input.providerRef, input.status, input.updatedAt, input.leaseId),
      this.db.prepare(`SELECT ${sandboxLeaseColumns} FROM sandbox_leases WHERE id = ? LIMIT 1`).bind(input.leaseId),
    ]);

    if (results[0]?.meta.changes !== 1) {
      throw new Error(`Sandbox lease not found: ${input.leaseId}`);
    }

    return toSandboxLeaseRecord(requireBatchRow<SandboxLeaseRow>(results, 1, "update sandbox lease"));
  }
}

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
              sandbox_duration_ms,
              failure_reason,
              created_at,
              started_at,
              finished_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, 0, 0, 0, NULL, ?, NULL, NULL)`,
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
        this.db.prepare(`SELECT ${agentRunColumns} FROM agent_runs WHERE id = ? LIMIT 1`).bind(input.agentRunId),
      ]);

      return {
        inputMessage: toMessageRecord(requireBatchRow<MessageRow>(results, 2, "create queued AgentRun message")),
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

  async findActiveOwnedByProjectId(projectId: string, userId: string): Promise<AgentRunRecord | null> {
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

  async transition(input: {
    failureReason?: string | null;
    finishedAt?: string | null;
    from: AgentRunStatus;
    runId: string;
    startedAt?: string | null;
    to: AgentRunStatus;
  }): Promise<AgentRunRecord | null> {
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

    values.push(input.runId, input.from);

    const results = await this.db.batch<AgentRunRow>([
      this.db
        .prepare(`UPDATE agent_runs SET ${assignments.join(", ")} WHERE id = ? AND status = ?`)
        .bind(...values),
      this.db.prepare(`SELECT ${agentRunColumns} FROM agent_runs WHERE id = ? LIMIT 1`).bind(input.runId),
    ]);

    if (results[0]?.meta.changes !== 1) {
      return null;
    }

    return toAgentRunRecord(requireBatchRow<AgentRunRow>(results, 1, "transition AgentRun"));
  }

  async updateUsage(runId: string, usage: AgentRunUsage): Promise<AgentRunRecord | null> {
    const results = await this.db.batch<AgentRunRow>([
      this.db
        .prepare(
          `UPDATE agent_runs
          SET input_tokens = ?,
              output_tokens = ?,
              total_tokens = ?,
              model_request_count = ?,
              sandbox_duration_ms = ?
          WHERE id = ?`,
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

    return toAgentRunRecord(requireBatchRow<AgentRunRow>(results, 1, "update AgentRun usage"));
  }
}
