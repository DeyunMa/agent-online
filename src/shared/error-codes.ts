export const publicErrorCodes = [
  "auth.unauthorized",
  "request.forbidden",
  "request.invalid",
  "request.too_large",
  "resource.not_found",
  "project.busy",
  "run.creation_disabled",
  "agent_runtime.unavailable",
  "sandbox.not_active",
  "sandbox.provider_unavailable",
  "project_path.not_found",
  "project_path.unsupported",
  "file.too_large",
  "file.content_unsupported",
  "preview.dependencies_missing",
  "preview.entry_missing",
  "preview.unavailable",
  "service.unavailable",
  "internal.unexpected",
] as const;

export type PublicErrorCode = (typeof publicErrorCodes)[number];

export const agentRunFailureCodes = [
  "run.start_failed",
  "run.sandbox_failed",
  "run.agent_protocol_failed",
  "run.agent_process_failed",
  "run.model_failed",
  "run.no_visible_reply",
  "run.timed_out",
  "run.interrupted",
  "run.internal_failed",
] as const;

export type AgentRunFailureCode = (typeof agentRunFailureCodes)[number];
export type FailedAgentRunFailureCode = Exclude<
  AgentRunFailureCode,
  "run.interrupted" | "run.timed_out"
>;

export function isPublicErrorCode(value: unknown): value is PublicErrorCode {
  return publicErrorCodes.some((code) => code === value);
}

export function isAgentRunFailureCode(value: unknown): value is AgentRunFailureCode {
  return agentRunFailureCodes.some((code) => code === value);
}
