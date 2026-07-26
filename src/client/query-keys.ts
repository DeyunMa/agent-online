export const projectQueryKey = ["projects"] as const;

export function projectDetailQueryKey(projectId: string) {
  return ["project", projectId] as const;
}

export function projectMessagesQueryKey(projectId: string) {
  return ["project-messages", projectId] as const;
}

export function activeAgentRunQueryKey(projectId: string) {
  return ["active-agent-run", projectId] as const;
}

export function agentRunsQueryKey(projectId: string) {
  return ["agent-runs", projectId] as const;
}

export function agentRunQueryKey(projectId: string, runId: string) {
  return ["agent-run", projectId, runId] as const;
}
