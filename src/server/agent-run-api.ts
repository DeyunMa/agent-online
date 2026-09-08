import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { createAgentRunRequestSchema } from "../shared/api";
import type { AppEnv } from "./env";
import { validateJsonRequest } from "./http/json-validator";
import type { ProjectApiDependencies } from "./project-api-dependencies";
import {
  type AppContext,
  agentRuntimeUnavailable,
  authenticateProjectRequest,
  internalError,
  notFound,
  projectBusy,
  requestDiagnosticContext,
  requireAuthenticatedUser,
  runsDisabled,
  toAgentRunResponse,
  unauthorized,
} from "./project-api-support";
import { streamRunLifecycle } from "./run-lifecycle-stream";

export function registerAgentRunRoutes(api: Hono<AppEnv>, dependencies: ProjectApiDependencies) {
  api.post(
    "/projects/:projectId/agent-runs",
    authenticateProjectRequest(dependencies),
    validateJsonRequest(createAgentRunRequestSchema),
    async (c) => {
      const user = c.get("authenticatedUser");
      const input = c.req.valid("json");

      const services = dependencies.createServices(c.env, requestDiagnosticContext(c));
      const project = await services.projectReads.findOwnedProject(
        c.req.param("projectId"),
        user.id,
      );
      if (!project) {
        return notFound(c);
      }
      if (!dependencies.getDeploymentPolicy(c.env).runsEnabled) {
        return runsDisabled(c);
      }
      const agentRuntimeId = input.agentRuntimeId ?? project.defaultAgentRuntimeId;
      if (!services.enabledAgentRuntimeIds.includes(agentRuntimeId)) {
        return agentRuntimeUnavailable(c);
      }

      const created = await services.createAgentRuns.create({
        agentRuntimeId,
        content: input.content,
        projectId: project.id,
        userId: user.id,
      });

      if (created.kind === "project_busy") {
        return projectBusy(c);
      }
      if (created.kind === "runtime_mismatch") {
        return internalError(c);
      }
      if (created.completion) {
        keepRunAlive(c, created.completion);
      }

      return c.json(toAgentRunResponse(created.run), 201);
    },
  );

  api.get("/projects/:projectId/agent-runs", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const runs = await dependencies
      .createServices(c.env, requestDiagnosticContext(c))
      .projectReads.listRecentOwnedRuns(c.req.param("projectId"), user.id);
    if (!runs) {
      return notFound(c);
    }
    return c.json(runs.map(toAgentRunResponse));
  });

  api.get("/projects/:projectId/agent-runs/active", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const run = await dependencies
      .createServices(c.env, requestDiagnosticContext(c))
      .projectReads.findActiveOwnedRun(c.req.param("projectId"), user.id);
    if (run === undefined) {
      return notFound(c);
    }
    return c.json(run ? toAgentRunResponse(run) : null);
  });

  api.get("/projects/:projectId/agent-runs/:runId", async (c) => {
    const access = await getOwnedRun(c, dependencies);
    if (!access) {
      return access === null ? unauthorized(c) : notFound(c);
    }

    const run = access.run;
    return c.json(toAgentRunResponse(run));
  });

  api.post("/projects/:projectId/agent-runs/:runId/cancel", async (c) => {
    const access = await getOwnedRun(c, dependencies);
    if (!access) {
      return access === null ? unauthorized(c) : notFound(c);
    }

    const run = access.run;

    access.services.diagnostics.report({
      agentRuntimeId: run.agentRuntimeId,
      event: "agent_run.cancel_requested",
      modelId: run.modelId,
      outcome: "started",
      runId: run.id,
      runStatus: run.status,
      sandboxRuntimeId: run.sandboxRuntimeId,
      stage: "cancel",
    });
    const cancelled = await access.services.runExecutions.cancel(run, dependencies.now());
    return cancelled ? c.json(toAgentRunResponse(cancelled)) : internalError(c);
  });

  api.get("/projects/:projectId/agent-runs/:runId/events", async (c) => {
    const access = await getOwnedRun(c, dependencies);
    if (!access) {
      return access === null ? unauthorized(c) : notFound(c);
    }

    const run = access.run;

    return streamSSE(c, (stream) =>
      streamRunLifecycle(stream, run, () =>
        access.services.projectReads.findOwnedRun(run.projectId, run.id, access.userId),
      ),
    );
  });
}

async function getOwnedRun(c: AppContext, dependencies: ProjectApiDependencies) {
  const user = await requireAuthenticatedUser(c, dependencies);
  if (!user) {
    return null;
  }

  const services = dependencies.createServices(c.env, requestDiagnosticContext(c));
  const projectId = c.req.param("projectId");
  const runId = c.req.param("runId");
  if (!projectId || !runId) {
    return false;
  }
  const run = await services.projectReads.findOwnedRun(projectId, runId, user.id);
  return run
    ? {
        run,
        services,
        userId: user.id,
      }
    : false;
}

function keepRunAlive(c: AppContext, completion: Promise<unknown>) {
  const settled = completion.catch(() => undefined);

  try {
    c.executionCtx.waitUntil(settled);
  } catch {
    // Hono's in-memory request helper does not provide an ExecutionContext.
  }
}
