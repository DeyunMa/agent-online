import type {
  AgentRunRecord,
  AgentRunRepository,
  AgentRunUsage,
  AgentRunUsageDelta,
  CreateQueuedAgentRunResult,
  MessageRecord,
  MessageRepository,
  ProjectRecord,
  ProjectRepository,
  SandboxLeaseRecord,
  SandboxLeaseRepository,
  TerminalSessionRecord,
  TerminalSessionRepository,
} from "../../application/ports";
import type {
  AgentRuntimeUsageSummary,
  ProjectUsageSummary,
  UsageMetrics,
  UserUsageRepository,
  UserUsageSummary,
} from "../../application/user-usage";
import type { AgentRuntimeId } from "../../agent/contract";
import { isTerminalAgentRun, type AgentRunStatus } from "../../domain/agent-run";
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
  provider_process_ref: string | null;
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

type TerminalSessionRow = {
  created_at: string;
  expires_at: string;
  id: string;
  project_id: string;
  provider_process_ref: string | null;
  provider_sandbox_ref: string | null;
  sandbox_lease_id: string;
  updated_at: string;
};

type UsageAggregateRow = {
  input_tokens: number;
  model_request_count: number;
  output_tokens: number;
  run_count: number;
  sandbox_duration_ms: number;
  total_tokens: number;
};

type ProjectUsageRow = UsageAggregateRow & {
  project_id: string;
  project_title: string;
};

type AgentRuntimeUsageRow = UsageAggregateRow & {
  agent_runtime_id: AgentRuntimeId;
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
  provider_process_ref,
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

const terminalSessionColumns = `
  id,
  project_id,
  sandbox_lease_id,
  provider_sandbox_ref,
  provider_process_ref,
  expires_at,
  created_at,
  updated_at
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
    providerProcessRef: row.provider_process_ref,
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

function toTerminalSessionRecord(
  row: TerminalSessionRow,
): TerminalSessionRecord {
  return {
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    id: row.id,
    projectId: row.project_id,
    providerProcessRef: row.provider_process_ref,
    providerSandboxRef: row.provider_sandbox_ref,
    sandboxLeaseId: row.sandbox_lease_id,
    updatedAt: row.updated_at,
  };
}

function toUsageMetrics(row: UsageAggregateRow): UsageMetrics {
  const metrics = {
    inputTokens: row.input_tokens,
    modelRequestCount: row.model_request_count,
    outputTokens: row.output_tokens,
    runCount: row.run_count,
    sandboxDurationMs: row.sandbox_duration_ms,
    totalTokens: row.total_tokens,
  };

  for (const value of Object.values(metrics)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("D1 returned invalid user usage");
    }
  }

  return metrics;
}

function toProjectUsageSummary(row: ProjectUsageRow): ProjectUsageSummary {
  return {
    projectId: row.project_id,
    projectTitle: row.project_title,
    usage: toUsageMetrics(row),
  };
}

function toAgentRuntimeUsageSummary(
  row: AgentRuntimeUsageRow,
): AgentRuntimeUsageSummary {
  return {
    agentRuntimeId: row.agent_runtime_id,
    usage: toUsageMetrics(row),
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
    text.includes("project_terminal_active") ||
    ((text.includes("agent_runs.project_id") ||
      text.includes("agent_runs_one_active_per_project")) &&
      (text.includes("unique") || text.includes("constraint")))
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

  async appendAssistant(input: {
    agentRunId: string;
    content: string;
    id: string;
    now: string;
    projectId: string;
  }): Promise<MessageRecord> {
    const results = await this.db.batch<MessageRow>([
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
          ) VALUES (?, ?, ?, COALESCE((SELECT MAX(sequence) + 1 FROM messages WHERE project_id = ?), 0), 'assistant', ?, ?)`,
        )
        .bind(
          input.id,
          input.projectId,
          input.agentRunId,
          input.projectId,
          input.content,
          input.now,
        ),
      this.db
        .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
        .bind(input.now, input.projectId),
      this.db
        .prepare(
          `SELECT ${messageColumns}
          FROM messages
          WHERE project_id = ? AND agent_run_id = ? AND role = 'assistant'
          LIMIT 1`,
        )
        .bind(input.projectId, input.agentRunId),
    ]);

    return toMessageRecord(requireBatchRow<MessageRow>(results, 2, "append assistant message"));
  }

  async findById(messageId: string, projectId: string): Promise<MessageRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${messageColumns} FROM messages WHERE id = ? AND project_id = ? LIMIT 1`)
      .bind(messageId, projectId)
      .first<MessageRow>();

    return row === null ? null : toMessageRecord(row);
  }

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

  async claimIdleAfterActivityForStop(input: {
    expectedProviderRef: string;
    expectedUpdatedAt: string;
    leaseId: string;
    updatedAt: string;
  }) {
    const result = await this.db
      .prepare(
        `UPDATE sandbox_leases
        SET provider_ref = NULL, status = 'stopped', updated_at = ?
        WHERE id = ?
          AND provider_ref = ?
          AND status = 'idle'
          AND updated_at = ?
          AND NOT EXISTS (
            SELECT 1
            FROM agent_runs
            WHERE project_id = sandbox_leases.project_id
              AND status IN ('queued', 'starting', 'running', 'cancelling')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM terminal_sessions
            WHERE project_id = sandbox_leases.project_id
          )`,
      )
      .bind(
        input.updatedAt,
        input.leaseId,
        input.expectedProviderRef,
        input.expectedUpdatedAt,
      )
      .run();

    return result.meta.changes === 1;
  }

  async claimForManualStop(input: {
    expectedProviderRef: string;
    expectedUpdatedAt: string;
    leaseId: string;
    updatedAt: string;
  }) {
    const result = await this.db
      .prepare(
        `UPDATE sandbox_leases
        SET provider_ref = NULL, status = 'stopped', updated_at = ?
        WHERE id = ?
          AND provider_ref = ?
          AND status != 'stopped'
          AND updated_at = ?
          AND NOT EXISTS (
            SELECT 1
            FROM agent_runs
            WHERE project_id = sandbox_leases.project_id
              AND status IN ('queued', 'starting', 'running', 'cancelling')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM terminal_sessions
            WHERE project_id = sandbox_leases.project_id
          )`,
      )
      .bind(
        input.updatedAt,
        input.leaseId,
        input.expectedProviderRef,
        input.expectedUpdatedAt,
      )
      .run();

    return result.meta.changes === 1;
  }

  async claimIdleForStop(input: {
    expectedProviderRef: string;
    expectedRunId: string;
    expectedUpdatedAt: string;
    leaseId: string;
    updatedAt: string;
  }) {
    const result = await this.db
      .prepare(
        `UPDATE sandbox_leases
        SET provider_ref = NULL, status = 'stopped', updated_at = ?
        WHERE id = ?
          AND provider_ref = ?
          AND status = 'idle'
          AND updated_at = ?
          AND (
            SELECT id
            FROM agent_runs
            WHERE project_id = sandbox_leases.project_id
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          ) = ?
          AND NOT EXISTS (
            SELECT 1
            FROM agent_runs
            WHERE project_id = sandbox_leases.project_id
              AND status IN ('queued', 'starting', 'running', 'cancelling')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM terminal_sessions
            WHERE project_id = sandbox_leases.project_id
          )`,
      )
      .bind(
        input.updatedAt,
        input.leaseId,
        input.expectedProviderRef,
        input.expectedUpdatedAt,
        input.expectedRunId,
      )
      .run();

    return result.meta.changes === 1;
  }

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

export class D1TerminalSessionRepository
  implements TerminalSessionRepository
{
  constructor(private readonly db: D1Database) {}

  async claim(input: {
    expectedLeaseProviderRef: string | null;
    expectedLeaseUpdatedAt: string;
    expiresAt: string;
    id: string;
    now: string;
    projectId: string;
    sandboxLeaseId: string;
  }) {
    const results = await this.db.batch<TerminalSessionRow>([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO terminal_sessions (
            id,
            project_id,
            sandbox_lease_id,
            provider_sandbox_ref,
            provider_process_ref,
            expires_at,
            created_at,
            updated_at
          )
          SELECT ?, ?, sandbox_leases.id, NULL, NULL, ?, ?, ?
          FROM sandbox_leases
          WHERE sandbox_leases.id = ?
            AND sandbox_leases.project_id = ?
            AND sandbox_leases.updated_at = ?
            AND sandbox_leases.provider_ref IS ?
            AND NOT EXISTS (
            SELECT 1
            FROM agent_runs
            WHERE project_id = ?
              AND status IN ('queued', 'starting', 'running', 'cancelling')
          )
            AND NOT EXISTS (
              SELECT 1
              FROM terminal_sessions
              WHERE project_id = ?
            )`,
        )
        .bind(
          input.id,
          input.projectId,
          input.expiresAt,
          input.now,
          input.now,
          input.sandboxLeaseId,
          input.projectId,
          input.expectedLeaseUpdatedAt,
          input.expectedLeaseProviderRef,
          input.projectId,
          input.projectId,
        ),
      this.db
        .prepare(
          `SELECT ${terminalSessionColumns}
          FROM terminal_sessions
          WHERE id = ?
          LIMIT 1`,
        )
        .bind(input.id),
    ]);

    if (results[0]?.meta.changes !== 1) {
      return { kind: "project_busy" } as const;
    }

    return {
      kind: "claimed" as const,
      session: toTerminalSessionRecord(
        requireBatchRow<TerminalSessionRow>(
          results,
          1,
          "claim Terminal session",
        ),
      ),
    };
  }

  async findById(sessionId: string) {
    const row = await this.db
      .prepare(
        `SELECT ${terminalSessionColumns}
        FROM terminal_sessions
        WHERE id = ?
        LIMIT 1`,
      )
      .bind(sessionId)
      .first<TerminalSessionRow>();

    return row === null ? null : toTerminalSessionRecord(row);
  }

  async findByProjectId(projectId: string) {
    const row = await this.db
      .prepare(
        `SELECT ${terminalSessionColumns}
        FROM terminal_sessions
        WHERE project_id = ?
        LIMIT 1`,
      )
      .bind(projectId)
      .first<TerminalSessionRow>();

    return row === null ? null : toTerminalSessionRecord(row);
  }

  async setProviderProcessRef(
    sessionId: string,
    providerProcessRef: string,
    now: string,
  ) {
    if (!providerProcessRef || providerProcessRef.length > 512) {
      throw new Error("Terminal provider process reference is invalid");
    }

    const results = await this.db.batch<TerminalSessionRow>([
      this.db
        .prepare(
          `UPDATE terminal_sessions
          SET provider_process_ref = ?, updated_at = ?
          WHERE id = ?
            AND provider_sandbox_ref IS NOT NULL
            AND provider_process_ref IS NULL
          `,
        )
        .bind(providerProcessRef, now, sessionId),
      this.db
        .prepare(
          `SELECT ${terminalSessionColumns}
          FROM terminal_sessions
          WHERE id = ?
          LIMIT 1`,
        )
        .bind(sessionId),
    ]);

    if (results[0]?.meta.changes !== 1) {
      return null;
    }

    return toTerminalSessionRecord(
      requireBatchRow<TerminalSessionRow>(
        results,
        1,
        "set Terminal process reference",
      ),
    );
  }

  async setProviderSandboxRef(
    sessionId: string,
    providerSandboxRef: string,
    now: string,
  ) {
    if (!providerSandboxRef || providerSandboxRef.length > 512) {
      throw new Error("Terminal provider sandbox reference is invalid");
    }

    const results = await this.db.batch<TerminalSessionRow>([
      this.db
        .prepare(
          `UPDATE terminal_sessions
          SET provider_sandbox_ref = ?, updated_at = ?
          WHERE id = ?
            AND provider_sandbox_ref IS NULL`,
        )
        .bind(providerSandboxRef, now, sessionId),
      this.db
        .prepare(
          `SELECT ${terminalSessionColumns}
          FROM terminal_sessions
          WHERE id = ?
          LIMIT 1`,
        )
        .bind(sessionId),
    ]);

    if (results[0]?.meta.changes !== 1) {
      return null;
    }

    return toTerminalSessionRecord(
      requireBatchRow<TerminalSessionRow>(
        results,
        1,
        "set Terminal sandbox reference",
      ),
    );
  }

  async release(sessionId: string) {
    const result = await this.db
      .prepare("DELETE FROM terminal_sessions WHERE id = ?")
      .bind(sessionId)
      .run();

    return result.meta.changes === 1;
  }

  async releaseAndMarkLeaseIdle(input: {
    expectedProviderSandboxRef: string;
    now: string;
    sessionId: string;
  }) {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE sandbox_leases
          SET status = 'idle', updated_at = ?
          WHERE id = (
            SELECT sandbox_lease_id
            FROM terminal_sessions
            WHERE id = ?
              AND provider_sandbox_ref = ?
          )
            AND provider_ref = ?`,
        )
        .bind(
          input.now,
          input.sessionId,
          input.expectedProviderSandboxRef,
          input.expectedProviderSandboxRef,
        ),
      this.db
        .prepare(
          `DELETE FROM terminal_sessions
          WHERE id = ?
            AND provider_sandbox_ref = ?
            AND EXISTS (
              SELECT 1
              FROM sandbox_leases
              WHERE sandbox_leases.id = terminal_sessions.sandbox_lease_id
                AND sandbox_leases.provider_ref = ?
                AND sandbox_leases.status = 'idle'
                AND sandbox_leases.updated_at = ?
            )`,
        )
        .bind(
          input.sessionId,
          input.expectedProviderSandboxRef,
          input.expectedProviderSandboxRef,
          input.now,
        ),
    ]);

    return (
      results[0]?.meta.changes === 1 &&
      results[1]?.meta.changes === 1
    );
  }

  async releaseAndMarkLeaseStopped(input: {
    expectedProviderSandboxRef: string;
    now: string;
    sessionId: string;
  }) {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE sandbox_leases
          SET provider_ref = NULL, status = 'stopped', updated_at = ?
          WHERE id = (
            SELECT sandbox_lease_id
            FROM terminal_sessions
            WHERE id = ?
              AND provider_sandbox_ref = ?
          )
            AND provider_ref = ?`,
        )
        .bind(
          input.now,
          input.sessionId,
          input.expectedProviderSandboxRef,
          input.expectedProviderSandboxRef,
        ),
      this.db
        .prepare(
          `DELETE FROM terminal_sessions
          WHERE id = ?
            AND provider_sandbox_ref = ?
            AND EXISTS (
              SELECT 1
              FROM sandbox_leases
              WHERE sandbox_leases.id = terminal_sessions.sandbox_lease_id
                AND sandbox_leases.provider_ref IS NULL
                AND sandbox_leases.status = 'stopped'
                AND sandbox_leases.updated_at = ?
            )`,
        )
        .bind(
          input.sessionId,
          input.expectedProviderSandboxRef,
          input.now,
        ),
    ]);

    return (
      results[0]?.meta.changes === 1 &&
      results[1]?.meta.changes === 1
    );
  }

  async markLeaseFailedKeepingSession(input: {
    expectedProviderSandboxRef: string;
    now: string;
    sessionId: string;
  }) {
    const result = await this.db
      .prepare(
        `UPDATE sandbox_leases
        SET status = 'failed', updated_at = ?
        WHERE id = (
          SELECT sandbox_lease_id
          FROM terminal_sessions
          WHERE id = ?
            AND provider_sandbox_ref = ?
        )
          AND provider_ref = ?`,
      )
      .bind(
        input.now,
        input.sessionId,
        input.expectedProviderSandboxRef,
        input.expectedProviderSandboxRef,
      )
      .run();

    return result.meta.changes === 1;
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

    return toAgentRunRecord(requireBatchRow<AgentRunRow>(results, 1, "set AgentRun process reference"));
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

    return toAgentRunRecord(requireBatchRow<AgentRunRow>(results, 1, "set AgentRun sandbox duration"));
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

    if (isTerminalAgentRun(input.to)) {
      assignments.push("provider_process_ref = NULL");
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

export class D1UserUsageRepository implements UserUsageRepository {
  constructor(private readonly db: D1Database) {}

  async summarizeByUser(userId: string): Promise<UserUsageSummary> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `SELECT
            COUNT(*) AS run_count,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(model_request_count), 0) AS model_request_count,
            COALESCE(SUM(sandbox_duration_ms), 0) AS sandbox_duration_ms
          FROM agent_runs
          WHERE user_id = ?`,
        )
        .bind(userId),
      this.db
        .prepare(
          `SELECT
            agent_runs.project_id,
            projects.title AS project_title,
            COUNT(*) AS run_count,
            COALESCE(SUM(agent_runs.input_tokens), 0) AS input_tokens,
            COALESCE(SUM(agent_runs.output_tokens), 0) AS output_tokens,
            COALESCE(SUM(agent_runs.total_tokens), 0) AS total_tokens,
            COALESCE(SUM(agent_runs.model_request_count), 0) AS model_request_count,
            COALESCE(SUM(agent_runs.sandbox_duration_ms), 0) AS sandbox_duration_ms
          FROM agent_runs
          INNER JOIN projects ON projects.id = agent_runs.project_id
          WHERE agent_runs.user_id = ?
          GROUP BY agent_runs.project_id, projects.title
          ORDER BY total_tokens DESC, run_count DESC, projects.title ASC, agent_runs.project_id ASC`,
        )
        .bind(userId),
      this.db
        .prepare(
          `SELECT
            agent_runtime_id,
            COUNT(*) AS run_count,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(model_request_count), 0) AS model_request_count,
            COALESCE(SUM(sandbox_duration_ms), 0) AS sandbox_duration_ms
          FROM agent_runs
          WHERE user_id = ?
          GROUP BY agent_runtime_id
          ORDER BY total_tokens DESC, run_count DESC, agent_runtime_id ASC`,
        )
        .bind(userId),
    ]);

    const totals = requireBatchRow<UsageAggregateRow>(
      results,
      0,
      "summarize user usage",
    );
    const projects = (results[1]?.results ?? []) as ProjectUsageRow[];
    const agentRuntimes = (results[2]?.results ?? []) as AgentRuntimeUsageRow[];

    return {
      agentRuntimes: agentRuntimes.map(toAgentRuntimeUsageSummary),
      projects: projects.map(toProjectUsageSummary),
      totals: toUsageMetrics(totals),
    };
  }
}

function assertUsageDelta(usage: AgentRunUsageDelta) {
  for (const value of Object.values(usage)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("AgentRun usage deltas must be non-negative safe integers");
    }
  }
}
