import type { AgentRuntimeId } from "../agent/contract";
import type { AgentRunStatus } from "../domain/agent-run";
import type { SandboxLeaseStatus } from "../domain/sandbox-lease";
import type { RuntimeKind } from "../runtime/contract";

export type HealthResponse = {
  name: "agent-online";
  requestId: string;
  status: "ok";
};

export type RuntimeConfigResponse = {
  defaultAgentRuntime: "pi";
  maxActiveSandboxesPerUser: 1;
  maxRunWallSeconds: number;
  runtimeIdleTtlSeconds: number;
  runtimeProvider: RuntimeKind;
};

export type SandboxLeaseResponse = {
  id: string;
  runtimeId: RuntimeKind;
  status: SandboxLeaseStatus;
  updatedAt: string;
};

export type ProjectResponse = {
  createdAt: string;
  defaultAgentRuntimeId: AgentRuntimeId;
  id: string;
  sandboxLease: SandboxLeaseResponse | null;
  title: string;
  updatedAt: string;
};

export type MessageResponse = {
  agentRunId: string | null;
  content: string;
  createdAt: string;
  id: string;
  role: "user" | "assistant";
  sequence: number;
};

export type AgentRunUsageResponse = {
  inputTokens: number;
  modelRequestCount: number;
  outputTokens: number;
  sandboxDurationMs: number;
  totalTokens: number;
};

export type AgentRunResponse = {
  agentRuntimeId: AgentRuntimeId;
  createdAt: string;
  failureReason: string | null;
  finishedAt: string | null;
  id: string;
  inputMessageId: string | null;
  modelId: string;
  sandboxLeaseId: string;
  sandboxRuntimeId: RuntimeKind;
  startedAt: string | null;
  status: AgentRunStatus;
  usage: AgentRunUsageResponse;
};

export type CreateProjectRequest = {
  title: string;
};

export type CreateAgentRunRequest = {
  content: string;
};

export type AgentRunStreamEvent =
  | { sequence: number; status: AgentRunStatus; type: "run.status" }
  | { chunk: string; sequence: number; type: "agent.output" }
  | { sequence: number; tool: string; type: "agent.tool.started" }
  | { sequence: number; type: "run.completed"; usage: AgentRunUsageResponse };

export type ApiErrorResponse = {
  error: "forbidden" | "internal_error" | "not_found" | "project_busy" | "unauthorized" | "validation_error";
  requestId: string;
};
