import { getTableColumns, type Table } from "drizzle-orm";
import type { AgentRuntimeId } from "../../agent/contract";
import type {
  AgentRunRecord,
  MessageRecord,
  PreviewSessionRecord,
  ProjectRecord,
  SandboxLeaseRecord,
  TerminalSessionRecord,
} from "../../application/ports";
import type {
  AgentRuntimeUsageSummary,
  ProjectUsageSummary,
  UsageMetrics,
} from "../../application/user-usage";
import {
  agentRuns,
  messages,
  previewSessions,
  type projects,
  sandboxLeases,
  terminalSessions,
} from "./schema";

export type ProjectRow = typeof projects.$inferSelect;
export type SandboxLeaseRow = typeof sandboxLeases.$inferSelect;
export type AgentRunRow = Omit<typeof agentRuns.$inferSelect, "failure_reason">;
export type MessageRow = typeof messages.$inferSelect;
export type TerminalSessionRow = typeof terminalSessions.$inferSelect;
export type PreviewSessionRow = typeof previewSessions.$inferSelect;

export type UsageAggregateRow = {
  input_tokens: number;
  model_request_count: number;
  output_tokens: number;
  run_count: number;
  sandbox_duration_ms: number;
  total_tokens: number;
};

export type ProjectUsageRow = UsageAggregateRow & {
  project_deleted: number;
  project_id: string;
  project_title: string;
};

export type AgentRuntimeUsageRow = UsageAggregateRow & {
  agent_runtime_id: AgentRuntimeId;
};

// Conditional lifecycle writes still use native D1 batch. Their read projections
// are derived from the same schema as Drizzle queries and never use SELECT *.
export const sandboxLeaseColumns = columnNames(sandboxLeases);
export const agentRunColumns = columnNames(agentRuns, ["failure_reason"]);
export const messageColumns = columnNames(messages);
export const terminalSessionColumns = columnNames(terminalSessions);
export const previewSessionColumns = columnNames(previewSessions);

function columnNames(table: Table, omitted: readonly string[] = []): string {
  return Object.values(getTableColumns(table))
    .map((column) => column.name)
    .filter((name) => !omitted.includes(name))
    .join(", ");
}

export function toProjectRecord(row: ProjectRow): ProjectRecord {
  return {
    createdAt: row.created_at,
    defaultAgentRuntimeId: row.default_agent_runtime_id,
    id: row.id,
    title: row.title,
    updatedAt: row.updated_at,
    userId: row.user_id,
  };
}

export function toSandboxLeaseRecord(row: SandboxLeaseRow): SandboxLeaseRecord {
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

export function toAgentRunRecord(row: AgentRunRow): AgentRunRecord {
  return {
    agentRuntimeId: row.agent_runtime_id,
    createdAt: row.created_at,
    failureCode: row.failure_code,
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

export function toMessageRecord(row: MessageRow): MessageRecord {
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

export function toTerminalSessionRecord(row: TerminalSessionRow): TerminalSessionRecord {
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

export function toPreviewSessionRecord(row: PreviewSessionRow): PreviewSessionRecord {
  return {
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    id: row.id,
    port: row.port,
    projectId: row.project_id,
    providerProcessRef: row.provider_process_ref,
    providerSandboxRef: row.provider_sandbox_ref,
    sandboxLeaseId: row.sandbox_lease_id,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

export function toUsageMetrics(row: UsageAggregateRow): UsageMetrics {
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

export function toProjectUsageSummary(row: ProjectUsageRow): ProjectUsageSummary {
  if (row.project_deleted !== 0 && row.project_deleted !== 1) {
    throw new Error("D1 returned invalid Project deletion state for user usage");
  }

  return {
    projectDeleted: row.project_deleted === 1,
    projectId: row.project_id,
    projectTitle: row.project_title,
    usage: toUsageMetrics(row),
  };
}

export function toAgentRuntimeUsageSummary(row: AgentRuntimeUsageRow): AgentRuntimeUsageSummary {
  return {
    agentRuntimeId: row.agent_runtime_id,
    usage: toUsageMetrics(row),
  };
}

export function requireRow<T>(row: T | null | undefined, operation: string): T {
  if (row === null || row === undefined) {
    throw new Error(`D1 ${operation} did not return a row`);
  }

  return row;
}

export function requireBatchRow<T>(
  results: readonly { results: unknown[] }[],
  index: number,
  operation: string,
): T {
  return requireRow(results[index]?.results[0] as T | undefined, operation);
}
