export type AgentRuntimeId = "pi" | "goose" | "claude-code" | "codex-cli";

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

export type RuntimeKind = "fake" | "e2b" | "cloudflare-container";

export type SandboxChangeKind =
  | "added"
  | "conflicted"
  | "deleted"
  | "modified"
  | "renamed"
  | "type_changed"
  | "untracked";
