import type { AgentRunStatus } from "../shared/protocol";
import type { AgentRunFailureCode } from "../shared/error-codes";

export { agentRunStatuses } from "../shared/protocol";
export type { AgentRunStatus } from "../shared/protocol";

const terminalStatuses = new Set<AgentRunStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);

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

export function isValidAgentRunFailure(
  status: AgentRunStatus,
  failureCode: AgentRunFailureCode | null,
) {
  if (status === "timed_out") {
    return failureCode === "run.timed_out";
  }
  if (status === "interrupted") {
    return failureCode === "run.interrupted";
  }
  if (status === "failed") {
    return (
      failureCode !== null && failureCode !== "run.timed_out" && failureCode !== "run.interrupted"
    );
  }

  return failureCode === null;
}
