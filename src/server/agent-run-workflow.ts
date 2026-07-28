import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

import { createE2BRunExecution } from "./e2b-run-execution";
import type { DiagnosticContext } from "../observability/contract";
import type { AgentRunWorkflowPayload, AppBindings } from "./env";
import { createProjectPreviewService, createProjectTerminalService } from "./services";

export class AgentRunWorkflow extends WorkflowEntrypoint<AppBindings, AgentRunWorkflowPayload> {
  override async run(event: Readonly<WorkflowEvent<AgentRunWorkflowPayload>>, step: WorkflowStep) {
    const payload = validatePayload(event.payload);
    const { config, service } = createE2BRunExecution(this.env, diagnosticContext(payload));

    if (payload.kind === "preview-expiry") {
      await step.sleepUntil("wait for preview session expiry", new Date(payload.expiresAt));
      const cleanup = await step.do(
        "expire preview session",
        {
          retries: {
            backoff: "constant",
            delay: "2 seconds",
            limit: 2,
          },
        },
        () =>
          createProjectPreviewService(this.env).expire(payload.projectId, payload.previewSessionId),
      );
      return {
        ...cleanup,
        previewSessionId: payload.previewSessionId,
      };
    }

    if (payload.kind === "preview-idle-cleanup") {
      await step.sleep(
        "wait for preview sandbox idle timeout",
        `${Math.ceil(config.idleTtlMs / 1_000)} seconds`,
      );
      const cleanup = await step.do(
        "stop preview idle sandbox",
        {
          retries: {
            backoff: "constant",
            delay: "2 seconds",
            limit: 1,
          },
        },
        () =>
          service.stopSandboxAfterActivityIdle({
            expectedLeaseUpdatedAt: payload.expectedLeaseUpdatedAt,
            projectId: payload.projectId,
          }),
      );

      return {
        detached: cleanup.detached,
        previewSessionId: payload.previewSessionId,
        stopped: cleanup.stopped,
      };
    }

    if (payload.kind === "terminal-expiry") {
      await step.sleepUntil("wait for terminal session expiry", new Date(payload.expiresAt));
      const cleanup = await step.do(
        "expire terminal session",
        {
          retries: {
            backoff: "constant",
            delay: "2 seconds",
            limit: 2,
          },
        },
        () =>
          createProjectTerminalService(this.env).expire(
            payload.projectId,
            payload.terminalSessionId,
          ),
      );
      return {
        ...cleanup,
        terminalSessionId: payload.terminalSessionId,
      };
    }

    if (payload.kind === "terminal-idle-cleanup") {
      await step.sleep(
        "wait for terminal sandbox idle timeout",
        `${Math.ceil(config.idleTtlMs / 1_000)} seconds`,
      );
      const cleanup = await step.do(
        "stop terminal idle sandbox",
        {
          retries: {
            backoff: "constant",
            delay: "2 seconds",
            limit: 1,
          },
        },
        () =>
          service.stopSandboxAfterActivityIdle({
            expectedLeaseUpdatedAt: payload.expectedLeaseUpdatedAt,
            projectId: payload.projectId,
          }),
      );

      return {
        detached: cleanup.detached,
        stopped: cleanup.stopped,
        terminalSessionId: payload.terminalSessionId,
      };
    }

    if (payload.kind === "execute") {
      await step.do(
        "execute agent run",
        {
          retries: {
            backoff: "constant",
            delay: "2 seconds",
            limit: 1,
          },
          timeout: `${Math.ceil((config.runTimeoutMs + 30_000) / 1_000)} seconds`,
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

function diagnosticContext(payload: AgentRunWorkflowPayload): DiagnosticContext {
  switch (payload.kind) {
    case "execute":
    case "idle-cleanup":
      return { runId: payload.runId };
    case "terminal-expiry":
    case "terminal-idle-cleanup":
      return { terminalSessionId: payload.terminalSessionId };
    case "preview-expiry":
    case "preview-idle-cleanup":
      return { previewSessionId: payload.previewSessionId };
  }
}

function validatePayload(value: Readonly<AgentRunWorkflowPayload>): AgentRunWorkflowPayload {
  if (value.kind === "terminal-idle-cleanup") {
    if (
      !isIdentifier(value.projectId) ||
      !isIdentifier(value.terminalSessionId) ||
      !isTimestamp(value.expectedLeaseUpdatedAt)
    ) {
      throw new NonRetryableError("Terminal idle Workflow payload is invalid");
    }
    return { ...value };
  }

  if (value.kind === "preview-idle-cleanup") {
    if (
      !isIdentifier(value.projectId) ||
      !isIdentifier(value.previewSessionId) ||
      !isTimestamp(value.expectedLeaseUpdatedAt)
    ) {
      throw new NonRetryableError("Preview idle Workflow payload is invalid");
    }
    return { ...value };
  }

  if (value.kind === "preview-expiry") {
    if (
      !isIdentifier(value.projectId) ||
      !isIdentifier(value.previewSessionId) ||
      !isTimestamp(value.expiresAt)
    ) {
      throw new NonRetryableError("Preview expiry Workflow payload is invalid");
    }
    return { ...value };
  }

  if (value.kind === "terminal-expiry") {
    if (
      !isIdentifier(value.projectId) ||
      !isIdentifier(value.terminalSessionId) ||
      !isTimestamp(value.expiresAt)
    ) {
      throw new NonRetryableError("Terminal expiry Workflow payload is invalid");
    }
    return { ...value };
  }

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

function isTimestamp(value: string) {
  return value.length >= 20 && value.length <= 40 && !Number.isNaN(Date.parse(value));
}
