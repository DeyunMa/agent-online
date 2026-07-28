import type { AgentRuntimeId } from "../agent/contract";
import type { AgentRunStatus } from "../domain/agent-run";
import type { SandboxLeaseStatus } from "../domain/sandbox-lease";
import type { RuntimeKind } from "../runtime/contract";
import type { AgentRunFailureCode } from "../shared/error-codes";

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

export type AgentRunUsageDelta = AgentRunUsage;

export type AgentRunRecord = {
  agentRuntimeId: AgentRuntimeId;
  createdAt: string;
  failureCode: AgentRunFailureCode | null;
  finishedAt: string | null;
  id: string;
  inputMessageId: string | null;
  modelId: string;
  projectId: string;
  providerProcessRef: string | null;
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

export type TerminalSessionRecord = {
  createdAt: string;
  expiresAt: string;
  id: string;
  projectId: string;
  providerProcessRef: string | null;
  providerSandboxRef: string | null;
  sandboxLeaseId: string;
  updatedAt: string;
};

export type PreviewSessionRecord = {
  createdAt: string;
  expiresAt: string;
  id: string;
  port: number;
  projectId: string;
  providerProcessRef: string | null;
  providerSandboxRef: string;
  sandboxLeaseId: string;
  status: "running" | "starting";
  updatedAt: string;
};

export interface ProjectRepository {
  create(
    input: Omit<ProjectRecord, "createdAt" | "updatedAt"> & { now: string },
  ): Promise<ProjectRecord>;
  deleteOwned(projectId: string, userId: string): Promise<boolean>;
  findOwnedById(projectId: string, userId: string): Promise<ProjectRecord | null>;
  listOwned(userId: string): Promise<ProjectRecord[]>;
  renameOwned(input: {
    projectId: string;
    title: string;
    updatedAt: string;
    userId: string;
  }): Promise<ProjectRecord | null>;
}

export interface MessageRepository {
  findById(messageId: string, projectId: string): Promise<MessageRecord | null>;
  listByProjectId(projectId: string): Promise<MessageRecord[]>;
}

export interface SandboxLeaseRepository {
  /**
   * Atomically detaches a provider sandbox for a user-requested stop only
   * while the Project still has no active Run.
   */
  claimForManualStop(input: {
    expectedProviderRef: string;
    expectedUpdatedAt: string;
    leaseId: string;
    updatedAt: string;
  }): Promise<boolean>;
  /**
   * Atomically detaches an idle provider sandbox only when the Lease has not
   * changed and the Project still has no active Run.
   */
  claimIdleForStop(input: {
    expectedProviderRef: string;
    expectedRunId: string;
    expectedUpdatedAt: string;
    leaseId: string;
    updatedAt: string;
  }): Promise<boolean>;
  /**
   * Atomically detaches an idle provider sandbox after a non-Run activity,
   * provided that the Lease has not changed since that activity ended.
   */
  claimIdleAfterActivityForStop(input: {
    expectedProviderRef: string;
    expectedUpdatedAt: string;
    leaseId: string;
    updatedAt: string;
  }): Promise<boolean>;
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

export type ClaimTerminalSessionResult =
  | {
      kind: "claimed";
      session: TerminalSessionRecord;
    }
  | { kind: "project_busy" };

export interface TerminalSessionRepository {
  /**
   * Atomically claims the Project for a single ephemeral Terminal only when no
   * AgentRun or Terminal is active and the Lease has not changed since read.
   */
  claim(input: {
    expectedLeaseProviderRef: string | null;
    expectedLeaseUpdatedAt: string;
    expiresAt: string;
    id: string;
    now: string;
    projectId: string;
    sandboxLeaseId: string;
  }): Promise<ClaimTerminalSessionResult>;
  findById(sessionId: string): Promise<TerminalSessionRecord | null>;
  findByProjectId(projectId: string): Promise<TerminalSessionRecord | null>;
  setProviderProcessRef(
    sessionId: string,
    providerProcessRef: string,
    now: string,
  ): Promise<TerminalSessionRecord | null>;
  setProviderSandboxRef(
    sessionId: string,
    providerSandboxRef: string,
    now: string,
  ): Promise<TerminalSessionRecord | null>;
  release(sessionId: string): Promise<boolean>;
  /**
   * Releases the Terminal lock and marks the same provider sandbox idle in one
   * D1 transaction. A stale connection cannot mutate a replacement session.
   */
  releaseAndMarkLeaseIdle(input: {
    expectedProviderSandboxRef: string;
    now: string;
    sessionId: string;
  }): Promise<boolean>;
  /**
   * Releases the Terminal lock only after the entire provider sandbox has been
   * stopped, atomically detaching that provider reference from the Lease.
   */
  releaseAndMarkLeaseStopped(input: {
    expectedProviderSandboxRef: string;
    now: string;
    sessionId: string;
  }): Promise<boolean>;
  /**
   * Keeps the Terminal lock while quarantining a provider sandbox whose PTY
   * and sandbox could not be confirmed stopped.
   */
  markLeaseFailedKeepingSession(input: {
    expectedProviderSandboxRef: string;
    now: string;
    sessionId: string;
  }): Promise<boolean>;
}

export type ClaimPreviewSessionResult =
  | { kind: "claimed"; session: PreviewSessionRecord }
  | { kind: "project_busy" };

export interface PreviewSessionRepository {
  /**
   * Atomically reserves Preview startup against an unchanged live Lease while
   * no AgentRun, Terminal, or other Preview startup is active.
   */
  claim(input: {
    expectedLeaseProviderRef: string;
    expectedLeaseUpdatedAt: string;
    expiresAt: string;
    id: string;
    now: string;
    port: number;
    projectId: string;
    sandboxLeaseId: string;
  }): Promise<ClaimPreviewSessionResult>;
  findById(sessionId: string): Promise<PreviewSessionRecord | null>;
  findByProjectId(projectId: string): Promise<PreviewSessionRecord | null>;
  markRunning(
    sessionId: string,
    providerProcessRef: string,
    now: string,
  ): Promise<PreviewSessionRecord | null>;
  release(input: { expectedProviderSandboxRef: string; sessionId: string }): Promise<boolean>;
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
  /** Internal execution-owner read used before stopping an idle Project sandbox. */
  findActiveByProjectId(projectId: string): Promise<AgentRunRecord | null>;
  findActiveOwnedByProjectId(projectId: string, userId: string): Promise<AgentRunRecord | null>;
  findOwnedById(agentRunId: string, userId: string): Promise<AgentRunRecord | null>;
  /** Returns the newest runs first. The adapter owns the bounded history size. */
  listRecentOwnedByProjectId(projectId: string, userId: string): Promise<AgentRunRecord[]>;
  /** Stores a provider-private process identifier while a Run is non-terminal. */
  setProviderProcessRef(runId: string, providerProcessRef: string): Promise<AgentRunRecord | null>;
  /** Idempotently records elapsed sandbox wall time while a Run is non-terminal. */
  setSandboxDuration(runId: string, sandboxDurationMs: number): Promise<AgentRunRecord | null>;
  /** Atomically adds real usage while a Run is non-terminal. */
  addUsageDelta(runId: string, usage: AgentRunUsageDelta): Promise<AgentRunRecord | null>;
  /**
   * Atomically completes a running AgentRun, records its sandbox duration,
   * appends at most one final assistant Message, and touches the Project.
   * Returns null when the Run is no longer running.
   */
  completeSucceeded(input: {
    assistantMessage: {
      content: string;
      id: string;
    } | null;
    finishedAt: string;
    runId: string;
    sandboxDurationMs: number;
  }): Promise<AgentRunRecord | null>;
  transition(input: {
    failureCode?: AgentRunFailureCode | null;
    finishedAt?: string | null;
    from: AgentRunStatus;
    runId: string;
    startedAt?: string | null;
    to: AgentRunStatus;
  }): Promise<AgentRunRecord | null>;
}
