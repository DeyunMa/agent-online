import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

import { createE2BRunExecution } from "./e2b-run-execution";
import type { AgentRunWorkflowPayload, AppBindings } from "./env";

export class AgentRunWorkflow extends WorkflowEntrypoint<
  AppBindings,
  AgentRunWorkflowPayload
> {
  async run(
    event: Readonly<WorkflowEvent<AgentRunWorkflowPayload>>,
    step: WorkflowStep,
  ) {
    const payload = validatePayload(event.payload);
    const { config, service } = createE2BRunExecution(this.env);

    if (payload.kind === "execute") {
      await step.do(
        "execute agent run",
        {
          retries: {
            backoff: "constant",
            delay: "2 seconds",
            limit: 1,
          },
          timeout: `${Math.ceil(
            (config.runTimeoutMs + 30_000) / 1_000,
          )} seconds`,
        },
        async () => {
          const run = await service.execute(payload);
          return { runId: run.id, status: run.status };
        },
      );
    }

    await step.sleep(
      "wait for sandbox idle timeout",
      `${Math.ceil(config.idleTtlMs / 1_000)} seconds`,
    );
    const cleanup = await step.do(
      "stop idle sandbox",
      {
        retries: {
          backoff: "constant",
          delay: "2 seconds",
          limit: 1,
        },
      },
      () => service.stopSandboxIfIdle(payload),
    );

    return {
      detached: cleanup.detached,
      runId: payload.runId,
      stopped: cleanup.stopped,
    };
  }
}

function validatePayload(
  value: Readonly<AgentRunWorkflowPayload>,
): AgentRunWorkflowPayload {
  if (
    (value.kind !== "execute" && value.kind !== "idle-cleanup") ||
    !isIdentifier(value.projectId) ||
    !isIdentifier(value.runId)
  ) {
    throw new NonRetryableError("AgentRun Workflow payload is invalid");
  }

  return { ...value };
}

function isIdentifier(value: string) {
  return value.length >= 1 && value.length <= 100;
}
