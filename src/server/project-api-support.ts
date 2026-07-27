import type { Context } from "hono";
import type { z } from "zod";

import type {
  AgentRunRecord,
  MessageRecord,
  ProjectRecord,
  SandboxLeaseRecord,
} from "../application/ports";
import type { ProjectFilesFailure } from "../application/project-files";
import type {
  AgentRunResponse,
  ApiErrorResponse,
  MessageResponse,
  ProjectResponse,
  SandboxLeaseResponse,
} from "../shared/api";
import type { AppEnv } from "./env";
import type { ProjectApiDependencies } from "./project-api-dependencies";

export type AppContext = Context<AppEnv>;

export async function parseRequest<T extends z.ZodType>(
  c: AppContext,
  schema: T,
): Promise<z.output<T> | null> {
  try {
    const parsed = schema.safeParse(await c.req.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function requireAuthenticatedUser(c: AppContext, dependencies: ProjectApiDependencies) {
  return dependencies.getAuthenticatedUser(c.env, c.req.raw.headers);
}

export function toProjectResponse(
  project: ProjectRecord,
  sandboxLease: SandboxLeaseRecord | null,
): ProjectResponse {
  return {
    createdAt: project.createdAt,
    defaultAgentRuntimeId: project.defaultAgentRuntimeId,
    id: project.id,
    sandboxLease: sandboxLease ? toSandboxLeaseResponse(sandboxLease) : null,
    title: project.title,
    updatedAt: project.updatedAt,
  };
}

export function toAgentRunResponse(run: AgentRunRecord): AgentRunResponse {
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

export function toMessageResponse(message: MessageRecord): MessageResponse {
  return {
    agentRunId: message.agentRunId,
    content: message.content,
    createdAt: message.createdAt,
    id: message.id,
    role: message.role,
    sequence: message.sequence,
  };
}

export function unauthorized(c: AppContext) {
  return apiError(c, "unauthorized", 401);
}

export function validationError(c: AppContext) {
  return apiError(c, "validation_error", 400);
}

export function notFound(c: AppContext) {
  return apiError(c, "not_found", 404);
}

export function projectBusy(c: AppContext) {
  return apiError(c, "project_busy", 409);
}

export function agentRuntimeUnavailable(c: AppContext) {
  return apiError(c, "agent_runtime_unavailable", 409);
}

export function runsDisabled(c: AppContext) {
  return apiError(c, "runs_disabled", 503);
}

export function projectFilesError(c: AppContext, error: ProjectFilesFailure["kind"]) {
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

export function internalError(c: AppContext, status: 500 | 503 = 500) {
  return apiError(c, "internal_error", status);
}

function toSandboxLeaseResponse(sandboxLease: SandboxLeaseRecord): SandboxLeaseResponse {
  return {
    id: sandboxLease.id,
    runtimeId: sandboxLease.runtimeId,
    status: sandboxLease.status,
    updatedAt: sandboxLease.updatedAt,
  };
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
