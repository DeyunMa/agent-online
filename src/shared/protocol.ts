export const agentRuntimeIds = ["pi", "claude-code", "codex-cli"] as const;

export type AgentRuntimeId = (typeof agentRuntimeIds)[number];

export type SupportedAgentRuntimeId = "pi";

/** Static protocol support; deployment policy still decides which runtime is enabled. */
export function isSupportedAgentRuntimeId(id: AgentRuntimeId): id is SupportedAgentRuntimeId {
  return id === "pi";
}

export const agentRunStatuses = [
  "queued",
  "starting",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
] as const;

export type AgentRunStatus = (typeof agentRunStatuses)[number];

export const sandboxLeaseStatuses = [
  "stopped",
  "starting",
  "ready",
  "busy",
  "idle",
  "failed",
] as const;

export type SandboxLeaseStatus = (typeof sandboxLeaseStatuses)[number];

export const runtimeKinds = ["fake", "e2b", "cloudflare-container"] as const;

export type RuntimeKind = (typeof runtimeKinds)[number];

export const sandboxChangeKinds = [
  "added",
  "conflicted",
  "deleted",
  "modified",
  "renamed",
  "type_changed",
  "untracked",
] as const;

export type SandboxChangeKind = (typeof sandboxChangeKinds)[number];
