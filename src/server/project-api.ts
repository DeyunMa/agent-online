import { Hono, type Context } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { z } from "zod";

import type {
  AgentRunRecord,
  MessageRecord,
  ProjectRecord,
  SandboxLeaseRecord,
} from "../application/ports";
import { isTerminalAgentRun } from "../domain/agent-run";
import type {
  AgentRunResponse,
  AgentRunStreamEvent,
  ApiErrorResponse,
  MessageResponse,
  ProjectDirectoryResponse,
  ProjectFileResponse,
  ProjectResponse,
  SandboxLeaseResponse,
} from "../shared/api";
import { getAuthenticatedUser, type AuthenticatedUser } from "./auth-context";
import {
  getDeploymentPolicy,
  type DeploymentPolicy,
} from "./deployment-policy";
import type { AppBindings, AppEnv } from "./env";
import { createServerServices, type ServerServices } from "./services";
import { defaultWorkingDirectory } from "./runtime-config";

const createProjectSchema = z.object({
  title: z.string().trim().min(1).max(120),
});

const createAgentRunSchema = z.object({
  content: z.string().trim().min(1).max(64_000),
});

type AppContext = Context<AppEnv>;

export type ProjectApiDependencies = {
  createId: () => string;
  createServices: (env: AppBindings) => ServerServices;
  getDeploymentPolicy: (env: AppBindings) => DeploymentPolicy;
  getAuthenticatedUser: (env: AppBindings, headers: Headers) => Promise<AuthenticatedUser | null>;
  now: () => Date;
};

const defaultDependencies: ProjectApiDependencies = {
  createId: () => crypto.randomUUID(),
  createServices: createServerServices,
  getDeploymentPolicy,
  getAuthenticatedUser,
  now: () => new Date(),
};

const fakeRunStatusPollIntervalMs = 250;

export function createProjectApi(overrides: Partial<ProjectApiDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  const api = new Hono<AppEnv>();

  api.get("/projects", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const services = dependencies.createServices(c.env);
    const projects = await services.projects.listOwned(user.id);
    const responses = await Promise.all(
      projects.map(async (project) => toProjectResponse(project, await services.sandboxLeases.findByProjectId(project.id))),
    );

    return c.json(responses);
  });

  api.post("/projects", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const input = await parseRequest(c, createProjectSchema);
    if (!input) {
      return validationError(c);
    }

    const now = dependencies.now().toISOString();
    const project = await dependencies.createServices(c.env).projects.create({
      defaultAgentRuntimeId: "pi",
      id: dependencies.createId(),
      now,
      title: input.title,
      userId: user.id,
    });

    return c.json(toProjectResponse(project, null), 201);
  });

  api.get("/projects/:projectId", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const services = dependencies.createServices(c.env);
    const project = await services.projects.findOwnedById(c.req.param("projectId"), user.id);
    if (!project) {
      return notFound(c);
    }

    return c.json(toProjectResponse(project, await services.sandboxLeases.findByProjectId(project.id)));
  });

  api.post("/projects/:projectId/sandbox/stop", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const services = dependencies.createServices(c.env);
    const project = await services.projects.findOwnedById(
      c.req.param("projectId"),
      user.id,
    );
    if (!project) {
      return notFound(c);
    }

    const stopped = await services.projectSandboxes.stop(project.id);
    if (stopped.kind === "project_busy") {
      return projectBusy(c);
    }
    if (stopped.kind === "conflict" || stopped.kind === "provider_error") {
      return internalError(c, 503);
    }

    return c.json(toProjectResponse(project, stopped.lease));
  });

  api.get("/projects/:projectId/messages", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const services = dependencies.createServices(c.env);
    const project = await services.projects.findOwnedById(c.req.param("projectId"), user.id);
    if (!project) {
      return notFound(c);
    }

    const messages = await services.messages.listByProjectId(project.id);
    return c.json(messages.map(toMessageResponse));
  });

  api.get("/projects/:projectId/files", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const services = dependencies.createServices(c.env);
    const project = await services.projects.findOwnedById(c.req.param("projectId"), user.id);
    if (!project) {
      return notFound(c);
    }

    const result = await services.projectFiles.list(project.id, c.req.query("path"));
    if (result.kind !== "ok") {
      return projectFilesError(c, result.kind);
    }
    return c.json<ProjectDirectoryResponse>(result.directory);
  });

  api.get("/projects/:projectId/files/content", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const services = dependencies.createServices(c.env);
    const project = await services.projects.findOwnedById(c.req.param("projectId"), user.id);
    if (!project) {
      return notFound(c);
    }

    const result = await services.projectFiles.read(project.id, c.req.query("path"));
    if (result.kind !== "ok") {
      return projectFilesError(c, result.kind);
    }
    return c.json<ProjectFileResponse>(result.file);
  });

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

    const now = dependencies.now().toISOString();
    const sandboxLease = await services.sandboxLeases.getOrCreate({
      id: dependencies.createId(),
      now,
      projectId: project.id,
      runtimeId: services.sandboxRuntimeId,
    });
    if (sandboxLease.runtimeId !== services.sandboxRuntimeId) {
      return internalError(c);
    }
    const created = await services.agentRuns.createQueuedWithInput({
      agentRunId: dependencies.createId(),
      agentRuntimeId: project.defaultAgentRuntimeId,
      content: input.content,
      inputMessageId: dependencies.createId(),
      modelId: services.defaultModelId,
      now,
      projectId: project.id,
      sandboxLeaseId: sandboxLease.id,
      sandboxRuntimeId: sandboxLease.runtimeId,
      userId: user.id,
    });

    if (created.kind === "project_busy") {
      return projectBusy(c);
    }

    try {
      const execution = await services.runExecutions.start({
        agentRun: created.run,
        prompt: input.content,
        sandboxLease,
        workingDirectory: defaultWorkingDirectory,
      });

      if (execution.completion) {
        keepRunAlive(c, execution.completion);
      }
    } catch (_error) {
      const failed = await services.agentRuns.transition({
        failureReason: "Agent run could not be started",
        finishedAt: dependencies.now().toISOString(),
        from: "queued",
        runId: created.run.id,
        to: "failed",
      });
      const current = failed ?? (await services.agentRuns.findById(created.run.id));
      if (!current || current.status === "queued") {
        return internalError(c);
      }
      return c.json(toAgentRunResponse(current), 201);
    }

    return c.json(toAgentRunResponse(created.run), 201);
  });

  api.get("/projects/:projectId/agent-runs", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const services = dependencies.createServices(c.env);
    const project = await services.projects.findOwnedById(c.req.param("projectId"), user.id);
    if (!project) {
      return notFound(c);
    }

    const runs = await services.agentRuns.listRecentOwnedByProjectId(project.id, user.id);
    return c.json(runs.map(toAgentRunResponse));
  });

  api.get("/projects/:projectId/agent-runs/active", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const services = dependencies.createServices(c.env);
    const project = await services.projects.findOwnedById(c.req.param("projectId"), user.id);
    if (!project) {
      return notFound(c);
    }

    const run = await services.agentRuns.findActiveOwnedByProjectId(project.id, user.id);
    return c.json(run ? toAgentRunResponse(run) : null);
  });

  api.get("/projects/:projectId/agent-runs/:runId", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const services = dependencies.createServices(c.env);
    const project = await services.projects.findOwnedById(c.req.param("projectId"), user.id);
    if (!project) {
      return notFound(c);
    }

    const run = await findOwnedProjectRun(services, project, c.req.param("runId"), user.id);
    if (!run) {
      return notFound(c);
    }

    return c.json(toAgentRunResponse(run));
  });

  api.post("/projects/:projectId/agent-runs/:runId/cancel", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const services = dependencies.createServices(c.env);
    const project = await services.projects.findOwnedById(c.req.param("projectId"), user.id);
    if (!project) {
      return notFound(c);
    }

    const run = await findOwnedProjectRun(services, project, c.req.param("runId"), user.id);
    if (!run) {
      return notFound(c);
    }

    const cancelled = await services.runExecutions.cancel(run, dependencies.now());
    return cancelled ? c.json(toAgentRunResponse(cancelled)) : internalError(c);
  });

  api.get("/projects/:projectId/agent-runs/:runId/events", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const services = dependencies.createServices(c.env);
    const project = await services.projects.findOwnedById(c.req.param("projectId"), user.id);
    if (!project) {
      return notFound(c);
    }

    const run = await findOwnedProjectRun(services, project, c.req.param("runId"), user.id);
    if (!run) {
      return notFound(c);
    }

    return streamRunLifecycle(c, run, () => services.agentRuns.findOwnedById(run.id, user.id));
  });

  return api;
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

async function parseRequest<T extends z.ZodType>(c: AppContext, schema: T): Promise<z.output<T> | null> {
  try {
    const parsed = schema.safeParse(await c.req.json());
    return parsed.success ? parsed.data : null;
  } catch (_error) {
    return null;
  }
}

async function requireAuthenticatedUser(c: AppContext, dependencies: ProjectApiDependencies) {
  return dependencies.getAuthenticatedUser(c.env, c.req.raw.headers);
}

function keepRunAlive(c: AppContext, completion: Promise<unknown>) {
  const settled = completion.catch(() => undefined);

  try {
    c.executionCtx.waitUntil(settled);
  } catch (_error) {
    // Hono's in-memory request helper does not provide an ExecutionContext.
    // The rejection handler above still prevents an unhandled promise locally.
  }
}

function streamRunLifecycle(c: AppContext, initialRun: AgentRunRecord, readRun: () => Promise<AgentRunRecord | null>) {
  return streamSSE(c, async (stream) => {
    let sequence = 0;
    let run = initialRun;
    let emittedStatus = run.status;

    await writeStreamEvent(stream, { sequence: sequence++, status: emittedStatus, type: "run.status" });

    while (!isTerminalAgentRun(run.status)) {
      await delay(fakeRunStatusPollIntervalMs);
      const updatedRun = await readRun();
      if (!updatedRun) {
        return;
      }

      run = updatedRun;
      if (run.status !== emittedStatus) {
        emittedStatus = run.status;
        await writeStreamEvent(stream, { sequence: sequence++, status: emittedStatus, type: "run.status" });
      }
    }

    await writeStreamEvent(stream, {
      sequence,
      type: "run.completed",
      usage: run.usage,
    });
  });
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function writeStreamEvent(
  stream: SSEStreamingApi,
  event: AgentRunStreamEvent,
) {
  await stream.writeSSE({ data: JSON.stringify(event) });
}

function toProjectResponse(project: ProjectRecord, sandboxLease: SandboxLeaseRecord | null): ProjectResponse {
  return {
    createdAt: project.createdAt,
    defaultAgentRuntimeId: project.defaultAgentRuntimeId,
    id: project.id,
    sandboxLease: sandboxLease ? toSandboxLeaseResponse(sandboxLease) : null,
    title: project.title,
    updatedAt: project.updatedAt,
  };
}

function toSandboxLeaseResponse(sandboxLease: SandboxLeaseRecord): SandboxLeaseResponse {
  return {
    id: sandboxLease.id,
    runtimeId: sandboxLease.runtimeId,
    status: sandboxLease.status,
    updatedAt: sandboxLease.updatedAt,
  };
}

function toAgentRunResponse(run: AgentRunRecord): AgentRunResponse {
  return {
    agentRuntimeId: run.agentRuntimeId,
    createdAt: run.createdAt,
    failureReason: run.failureReason,
    finishedAt: run.finishedAt,
    id: run.id,
    inputMessageId: run.inputMessageId,
    modelId: run.modelId,
    sandboxLeaseId: run.sandboxLeaseId,
    sandboxRuntimeId: run.sandboxRuntimeId,
    startedAt: run.startedAt,
    status: run.status,
    usage: run.usage,
  };
}

function toMessageResponse(message: MessageRecord): MessageResponse {
  return message;
}

function unauthorized(c: AppContext) {
  return apiError(c, "unauthorized", 401);
}

function validationError(c: AppContext) {
  return apiError(c, "validation_error", 400);
}

function notFound(c: AppContext) {
  return apiError(c, "not_found", 404);
}

function projectBusy(c: AppContext) {
  return apiError(c, "project_busy", 409);
}

function runsDisabled(c: AppContext) {
  return apiError(c, "runs_disabled", 503);
}

function projectFilesError(
  c: AppContext,
  error:
    | "file_too_large"
    | "path_not_found"
    | "project_busy"
    | "provider_error"
    | "sandbox_unavailable"
    | "unsupported_file"
    | "unsupported_path",
) {
  switch (error) {
    case "file_too_large":
      return apiError(c, error, 413);
    case "path_not_found":
      return apiError(c, error, 404);
    case "project_busy":
      return apiError(c, error, 409);
    case "sandbox_unavailable":
      return apiError(c, error, 409);
    case "unsupported_file":
      return apiError(c, error, 415);
    case "unsupported_path":
      return apiError(c, error, 400);
    case "provider_error":
      return internalError(c, 503);
  }
}

function internalError(c: AppContext, status: 500 | 503 = 500) {
  return apiError(c, "internal_error", status);
}

function apiError(
  c: AppContext,
  error: ApiErrorResponse["error"],
  status: 400 | 401 | 404 | 409 | 413 | 415 | 500 | 503,
) {
  return c.json(
    {
      error,
      requestId: c.get("requestId") || crypto.randomUUID(),
    },
    status,
  );
}
