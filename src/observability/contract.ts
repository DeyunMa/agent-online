import type { AgentRunStatus, AgentRuntimeId, RuntimeKind } from "../shared/protocol";
import type { AgentRunFailureCode } from "../shared/error-codes";

export const diagnosticErrorCodes = [
  "RUN_DISPATCH_FAILED",
  "RUN_INPUT_UNAVAILABLE",
  "RUN_STATE_CONFLICT",
  "LEASE_INCONSISTENT",
  "SANDBOX_ENSURE_FAILED",
  "SANDBOX_PROCESS_FAILED",
  "AGENT_PROTOCOL_INVALID",
  "AGENT_PROCESS_FAILED",
  "MODEL_CAPABILITY_INVALID",
  "MODEL_UPSTREAM_REJECTED",
  "MODEL_UPSTREAM_TIMEOUT",
  "MODEL_USAGE_WRITE_FAILED",
  "PERSISTENCE_CONSTRAINT_UNEXPECTED",
  "PREVIEW_START_FAILED",
  "TERMINAL_RUNTIME_FAILED",
  "UNEXPECTED",
] as const;

export type DiagnosticErrorCode = (typeof diagnosticErrorCodes)[number];
export type DiagnosticSeverity = "error" | "info" | "warn";

export const diagnosticErrorDefinitions = {
  AGENT_PROCESS_FAILED: { retryable: true, severity: "error" },
  AGENT_PROTOCOL_INVALID: { retryable: false, severity: "error" },
  LEASE_INCONSISTENT: { retryable: false, severity: "error" },
  MODEL_CAPABILITY_INVALID: { retryable: false, severity: "warn" },
  MODEL_UPSTREAM_REJECTED: { retryable: true, severity: "error" },
  MODEL_UPSTREAM_TIMEOUT: { retryable: true, severity: "error" },
  MODEL_USAGE_WRITE_FAILED: { retryable: true, severity: "error" },
  PERSISTENCE_CONSTRAINT_UNEXPECTED: { retryable: false, severity: "error" },
  PREVIEW_START_FAILED: { retryable: true, severity: "error" },
  RUN_DISPATCH_FAILED: { retryable: true, severity: "error" },
  RUN_INPUT_UNAVAILABLE: { retryable: false, severity: "error" },
  RUN_STATE_CONFLICT: { retryable: false, severity: "error" },
  SANDBOX_ENSURE_FAILED: { retryable: true, severity: "error" },
  SANDBOX_PROCESS_FAILED: { retryable: true, severity: "error" },
  TERMINAL_RUNTIME_FAILED: { retryable: true, severity: "error" },
  UNEXPECTED: { retryable: true, severity: "error" },
} as const satisfies Record<
  DiagnosticErrorCode,
  { retryable: boolean; severity: DiagnosticSeverity }
>;

export type DiagnosticContext = {
  previewSessionId?: string;
  requestId?: string;
  runId?: string;
  terminalSessionId?: string;
};

export type DiagnosticEventName =
  | "agent_run.cancel_requested"
  | "agent_run.created"
  | "agent_run.dispatch_failed"
  | "agent_run.execution_finished"
  | "agent_run.execution_started"
  | "agent_run.stage_failed"
  | "model_gateway.request_failed"
  | "project_preview.failed"
  | "request.unhandled"
  | "sandbox.idle_cleanup_failed"
  | "sandbox.idle_cleanup_finished";

export type DiagnosticStage =
  | "authorize"
  | "cancel"
  | "claim_run"
  | "consume_events"
  | "dispatch"
  | "ensure_sandbox"
  | "idle_cleanup"
  | "issue_model_access"
  | "load_input"
  | "load_lease"
  | "mark_lease_busy"
  | "mark_lease_ready"
  | "mark_lease_starting"
  | "mark_run_running"
  | "persist_completion"
  | "persist_process_ref"
  | "preview_start"
  | "request"
  | "resolve_agent_runtime"
  | "resolve_sandbox_runtime"
  | "start_agent"
  | "upstream_fetch"
  | "upstream_response"
  | "usage_write";

export type DiagnosticEvent = DiagnosticContext & {
  agentRuntimeId?: AgentRuntimeId;
  attempt?: number;
  detached?: boolean;
  durationMs?: number;
  errorCode?: DiagnosticErrorCode;
  event: DiagnosticEventName;
  failureCode?: AgentRunFailureCode;
  inputTokens?: number;
  modelId?: string;
  modelRequestCount?: number;
  outcome: "failed" | "rejected" | "started" | "succeeded";
  outputTokens?: number;
  runStatus?: AgentRunStatus;
  sandboxDurationMs?: number;
  sandboxRuntimeId?: RuntimeKind;
  stage?: DiagnosticStage;
  stopped?: boolean;
  totalTokens?: number;
  upstreamCategory?:
    | "context_limit"
    | "model_not_found"
    | "other"
    | "rate_limited"
    | "thought_signature";
  upstreamHttpStatus?: number;
};

export interface DiagnosticReporter {
  report(event: DiagnosticEvent): void;
}

export const noopDiagnosticReporter: DiagnosticReporter = {
  report() {},
};
