import type { AgentRuntimeId } from "../agent/contract";
import type { AgentRunStatus } from "../domain/agent-run";
import type { SandboxLeaseStatus } from "../domain/sandbox-lease";
import type { RuntimeKind } from "../runtime/contract";

export type ProjectRecord = {
  createdAt: string;
  defaultAgentRuntimeId: AgentRuntimeId;
  id: string;
  title: string;
  updatedAt: string;
  userId: string;
};

export type SandboxLeaseRecord = {
  createdAt: string;
  id: string;
  projectId: string;
  providerRef: string | null;
  runtimeId: RuntimeKind;
  status: SandboxLeaseStatus;
  updatedAt: string;
};

export type AgentRunUsage = {
  inputTokens: number;
  modelRequestCount: number;
  outputTokens: number;
  sandboxDurationMs: number;
  totalTokens: number;
};

export type AgentRunRecord = {
  agentRuntimeId: AgentRuntimeId;
  createdAt: string;
  failureReason: string | null;
  finishedAt: string | null;
  id: string;
  inputMessageId: string | null;
  modelId: string;
  projectId: string;
  sandboxLeaseId: string;
  sandboxRuntimeId: RuntimeKind;
  startedAt: string | null;
  status: AgentRunStatus;
  usage: AgentRunUsage;
  userId: string;
};

export type MessageRecord = {
  agentRunId: string | null;
  content: string;
  createdAt: string;
  id: string;
  projectId: string;
  role: "user" | "assistant";
  sequence: number;
};

export interface ProjectRepository {
  create(input: Omit<ProjectRecord, "createdAt" | "updatedAt"> & { now: string }): Promise<ProjectRecord>;
  deleteOwned(projectId: string, userId: string): Promise<boolean>;
  findOwnedById(projectId: string, userId: string): Promise<ProjectRecord | null>;
  listOwned(userId: string): Promise<ProjectRecord[]>;
}

export interface MessageRepository {
  listByProjectId(projectId: string): Promise<MessageRecord[]>;
}

export interface SandboxLeaseRepository {
  findByProjectId(projectId: string): Promise<SandboxLeaseRecord | null>;
  getOrCreate(input: {
    id: string;
    now: string;
    projectId: string;
    runtimeId: RuntimeKind;
  }): Promise<SandboxLeaseRecord>;
  updateState(input: {
    providerRef: string | null;
    status: SandboxLeaseStatus;
    updatedAt: string;
    leaseId: string;
  }): Promise<SandboxLeaseRecord>;
}

export type CreateQueuedAgentRunResult =
  | { inputMessage: MessageRecord; kind: "created"; run: AgentRunRecord }
  | { kind: "project_busy" };

export interface AgentRunRepository {
  /**
   * Must create the user Message and queued AgentRun atomically. A partial unique index
   * turns concurrent calls for one Project into `project_busy` rather than two executions.
   */
  createQueuedWithInput(input: {
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
  }): Promise<CreateQueuedAgentRunResult>;
  /** Internal coordinator read after a cross-request cancellation transition. */
  findById(agentRunId: string): Promise<AgentRunRecord | null>;
  findActiveOwnedByProjectId(projectId: string, userId: string): Promise<AgentRunRecord | null>;
  findOwnedById(agentRunId: string, userId: string): Promise<AgentRunRecord | null>;
  transition(input: {
    failureReason?: string | null;
    finishedAt?: string | null;
    from: AgentRunStatus;
    runId: string;
    startedAt?: string | null;
    to: AgentRunStatus;
  }): Promise<AgentRunRecord | null>;
  updateUsage(runId: string, usage: AgentRunUsage): Promise<AgentRunRecord | null>;
}
