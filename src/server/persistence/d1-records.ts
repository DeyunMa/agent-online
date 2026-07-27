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
import type { AgentRuntimeId } from "../../agent/contract";
import type { AgentRunStatus } from "../../domain/agent-run";
import type { SandboxLeaseStatus } from "../../domain/sandbox-lease";
import type { RuntimeKind } from "../../runtime/contract";

export type ProjectRow = {
  created_at: string;
  default_agent_runtime_id: AgentRuntimeId;
  id: string;
  title: string;
  updated_at: string;
  user_id: string;
};

export type SandboxLeaseRow = {
  created_at: string;
  id: string;
  project_id: string;
  provider_ref: string | null;
  sandbox_runtime_id: RuntimeKind;
  status: SandboxLeaseStatus;
  updated_at: string;
};

export type AgentRunRow = {
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

export type MessageRow = {
  agent_run_id: string | null;
  content: string;
  created_at: string;
  id: string;
  project_id: string;
  role: "user" | "assistant";
  sequence: number;
};

export type TerminalSessionRow = {
  created_at: string;
  expires_at: string;
  id: string;
  project_id: string;
  provider_process_ref: string | null;
  provider_sandbox_ref: string | null;
  sandbox_lease_id: string;
  updated_at: string;
};

export type PreviewSessionRow = {
  created_at: string;
  expires_at: string;
  id: string;
  port: number;
  project_id: string;
  provider_process_ref: string | null;
  provider_sandbox_ref: string;
  sandbox_lease_id: string;
  status: PreviewSessionRecord["status"];
  updated_at: string;
};

export type UsageAggregateRow = {
  input_tokens: number;
  model_request_count: number;
  output_tokens: number;
  run_count: number;
  sandbox_duration_ms: number;
  total_tokens: number;
};

export type ProjectUsageRow = UsageAggregateRow & {
  project_id: string;
  project_title: string;
};

export type AgentRuntimeUsageRow = UsageAggregateRow & {
  agent_runtime_id: AgentRuntimeId;
};

export const projectColumns = `
  id,
  user_id,
  title,
  default_agent_runtime_id,
  created_at,
  updated_at
`;

export const sandboxLeaseColumns = `
  id,
  project_id,
  sandbox_runtime_id,
  provider_ref,
  status,
  created_at,
  updated_at
`;

export const agentRunColumns = `
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

export const messageColumns = `
  id,
  project_id,
  agent_run_id,
  sequence,
  role,
  content,
  created_at
`;

export const terminalSessionColumns = `
  id,
  project_id,
  sandbox_lease_id,
  provider_sandbox_ref,
  provider_process_ref,
  expires_at,
  created_at,
  updated_at
`;

export const previewSessionColumns = `
  id,
  project_id,
  sandbox_lease_id,
  provider_sandbox_ref,
  provider_process_ref,
  status,
  port,
  expires_at,
  created_at,
  updated_at
`;

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
  return {
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
