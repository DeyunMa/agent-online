export const projectQueryKey = ["projects"] as const;
export const platformCapabilitiesQueryKey = ["platform-capabilities"] as const;
export const userUsageQueryKey = ["user-usage"] as const;

export function projectDetailQueryKey(projectId: string) {
  return ["project", projectId] as const;
}

export function projectMessagesQueryKey(projectId: string) {
  return ["project-messages", projectId] as const;
}

export function projectFilesQueryKey(projectId: string, path: string) {
  return ["project-files", projectId, path] as const;
}

export function projectFileQueryKey(projectId: string, path: string) {
  return ["project-file", projectId, path] as const;
}

export function projectPreviewQueryKey(projectId: string) {
  return ["project-preview", projectId] as const;
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
