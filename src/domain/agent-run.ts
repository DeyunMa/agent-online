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

const terminalStatuses = new Set<AgentRunStatus>(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

const allowedTransitions: Readonly<Record<AgentRunStatus, readonly AgentRunStatus[]>> = {
  queued: ["starting", "cancelled", "failed"],
  starting: ["running", "cancelling", "failed", "timed_out", "interrupted"],
  running: ["succeeded", "cancelling", "failed", "timed_out", "interrupted"],
  cancelling: ["cancelled", "failed", "timed_out", "interrupted"],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
  interrupted: [],
};

export function canCreateAgentRun(currentStatus: AgentRunStatus | null) {
  return currentStatus === null || isTerminalAgentRun(currentStatus);
}

export function canTransitionAgentRun(from: AgentRunStatus, to: AgentRunStatus) {
  return allowedTransitions[from].includes(to);
}

export function isTerminalAgentRun(status: AgentRunStatus) {
  return terminalStatuses.has(status);
}
