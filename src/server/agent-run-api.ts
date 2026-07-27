import type { Hono } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { z } from "zod";

import type { AgentRunRecord, ProjectRecord } from "../application/ports";
import { isTerminalAgentRun } from "../domain/agent-run";
import type { AgentRunStreamEvent } from "../shared/api";
import type { AppEnv } from "./env";
import type { ProjectApiDependencies } from "./project-api-dependencies";
import {
  agentRuntimeUnavailable,
  type AppContext,
  internalError,
  notFound,
  parseRequest,
  projectBusy,
  requireAuthenticatedUser,
  runsDisabled,
  toAgentRunResponse,
  unauthorized,
  validationError,
} from "./project-api-support";
import type { ServerServices } from "./services";

const createAgentRunSchema = z.object({
  agentRuntimeId: z.enum(["pi", "goose"]).optional(),
  content: z.string().trim().min(1).max(64_000),
});

const runStatusPollIntervalMs = 750;

export function registerAgentRunRoutes(api: Hono<AppEnv>, dependencies: ProjectApiDependencies) {
  api.post("/projects/:projectId/agent-runs", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const input = await parseRequest(c, createAgentRunSchema);
    if (!input) {
      return validationError(c);
    }

    const services = dependencies.createServices(c.env);
    const project = await services.projects.findOwnedById(c.req.param("projectId"), user.id);
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
  });

  api.get("/projects/:projectId/agent-runs", async (c) => {
    const access = await getOwnedProject(c, dependencies);
    if (!access) {
      return access === null ? unauthorized(c) : notFound(c);
    }

    const runs = await access.services.agentRuns.listRecentOwnedByProjectId(
      access.project.id,
      access.userId,
    );
    return c.json(runs.map(toAgentRunResponse));
  });

  api.get("/projects/:projectId/agent-runs/active", async (c) => {
    const access = await getOwnedProject(c, dependencies);
    if (!access) {
      return access === null ? unauthorized(c) : notFound(c);
    }

    const run = await access.services.agentRuns.findActiveOwnedByProjectId(
      access.project.id,
      access.userId,
    );
    return c.json(run ? toAgentRunResponse(run) : null);
  });

  api.get("/projects/:projectId/agent-runs/:runId", async (c) => {
    const access = await getOwnedProject(c, dependencies);
    if (!access) {
      return access === null ? unauthorized(c) : notFound(c);
    }

    const run = await findOwnedProjectRun(
      access.services,
      access.project,
      c.req.param("runId"),
      access.userId,
    );
    return run ? c.json(toAgentRunResponse(run)) : notFound(c);
  });

  api.post("/projects/:projectId/agent-runs/:runId/cancel", async (c) => {
    const access = await getOwnedProject(c, dependencies);
    if (!access) {
      return access === null ? unauthorized(c) : notFound(c);
    }

    const run = await findOwnedProjectRun(
      access.services,
      access.project,
      c.req.param("runId"),
      access.userId,
    );
    if (!run) {
      return notFound(c);
    }

    const cancelled = await access.services.runExecutions.cancel(run, dependencies.now());
    return cancelled ? c.json(toAgentRunResponse(cancelled)) : internalError(c);
  });

  api.get("/projects/:projectId/agent-runs/:runId/events", async (c) => {
    const access = await getOwnedProject(c, dependencies);
    if (!access) {
      return access === null ? unauthorized(c) : notFound(c);
    }

    const run = await findOwnedProjectRun(
      access.services,
      access.project,
      c.req.param("runId"),
      access.userId,
    );
    if (!run) {
      return notFound(c);
    }

    return streamRunLifecycle(c, run, () =>
      access.services.agentRuns.findOwnedById(run.id, access.userId),
    );
  });
}

async function getOwnedProject(c: AppContext, dependencies: ProjectApiDependencies) {
  const user = await requireAuthenticatedUser(c, dependencies);
  if (!user) {
    return null;
  }

  const services = dependencies.createServices(c.env);
  const projectId = c.req.param("projectId");
  if (!projectId) {
    return false;
  }
  const project = await services.projects.findOwnedById(projectId, user.id);
  return project
    ? {
        project,
        services,
        userId: user.id,
      }
    : false;
}

async function findOwnedProjectRun(
  services: ServerServices,
  project: ProjectRecord,
  runId: string,
  userId: string,
) {
  const run = await services.agentRuns.findOwnedById(runId, userId);
  return run?.projectId === project.id ? run : null;
}

function keepRunAlive(c: AppContext, completion: Promise<unknown>) {
  const settled = completion.catch(() => undefined);

  try {
    c.executionCtx.waitUntil(settled);
  } catch {
    // Hono's in-memory request helper does not provide an ExecutionContext.
  }
}

function streamRunLifecycle(
  c: AppContext,
  initialRun: AgentRunRecord,
  readRun: () => Promise<AgentRunRecord | null>,
) {
  return streamSSE(c, async (stream) => {
    let aborted = false;
    let sequence = 0;
    let run = initialRun;
    let emittedStatus = run.status;

    stream.onAbort(() => {
      aborted = true;
    });

    await writeStreamEvent(stream, {
      sequence: sequence++,
      status: emittedStatus,
      type: "run.status",
    });

    while (!aborted && !isTerminalAgentRun(run.status)) {
      await delay(runStatusPollIntervalMs);
      if (aborted) {
        return;
      }

      const updatedRun = await readRun();
      if (!updatedRun) {
        return;
      }

      run = updatedRun;
      if (run.status !== emittedStatus) {
        emittedStatus = run.status;
        await writeStreamEvent(stream, {
          sequence: sequence++,
          status: emittedStatus,
          type: "run.status",
        });
      }
    }

    if (!aborted) {
      await writeStreamEvent(stream, {
        sequence,
        type: "run.completed",
        usage: run.usage,
      });
    }
  });
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function writeStreamEvent(stream: SSEStreamingApi, event: AgentRunStreamEvent) {
  await stream.writeSSE({ data: JSON.stringify(event) });
}
