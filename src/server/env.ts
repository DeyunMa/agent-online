export type AgentRunWorkflowPayload =
  | {
      kind: "execute" | "idle-cleanup";
      projectId: string;
      runId: string;
    }
  | {
      expectedLeaseUpdatedAt: string;
      kind: "terminal-idle-cleanup";
      projectId: string;
      terminalSessionId: string;
    }
  | {
      expiresAt: string;
      kind: "terminal-expiry";
      projectId: string;
      terminalSessionId: string;
    }
  | {
      expectedLeaseUpdatedAt: string;
      kind: "preview-idle-cleanup";
      previewSessionId: string;
      projectId: string;
    }
  | {
      expiresAt: string;
      kind: "preview-expiry";
      previewSessionId: string;
      projectId: string;
    };

export interface AppBindings {
  ACCESS_ALLOWED_EMAILS?: string;
  ACCESS_MODE?: string;
  AGENT_RUN_WORKFLOW: Workflow<AgentRunWorkflowPayload>;
  ASSETS: Fetcher;
  ADMIN_EMAILS?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  DB: D1Database;
  DEFAULT_MODEL_ID?: string;
  E2B_API_KEY?: string;
  E2B_TEMPLATE_ID?: string;
  GEMINI_API_KEY?: string;
  GOOSE_RUNTIME_MODE?: string;
  MAX_RUN_WALL_SECONDS?: string;
  MODEL_GATEWAY_BASE_URL?: string;
  RUNS_ENABLED?: string;
  RUNTIME_IDLE_TTL_SECONDS?: string;
  RUNTIME_PROVIDER?: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
}

export interface AppVariables {
  requestId: string;
}

export type AppEnv = {
  Bindings: AppBindings;
  Variables: AppVariables;
};
