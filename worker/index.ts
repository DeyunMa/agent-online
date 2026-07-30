import { instrumentWorkflowWithSentry } from "@sentry/cloudflare";

import { AgentRunWorkflow as AgentRunWorkflowBase } from "../src/server/agent-run-workflow";
import { app } from "../src/server/app";
import type { AppBindings } from "../src/server/env";
import { createServerSentryOptions } from "../src/server/observability/sentry";

export const AgentRunWorkflow = instrumentWorkflowWithSentry(
  (env: AppBindings) => createServerSentryOptions(env),
  AgentRunWorkflowBase,
);

export default app;
