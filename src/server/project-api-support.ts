import type { Context } from "hono";
import type { z } from "zod";

import type {
  AgentRunRecord,
  MessageRecord,
  ProjectRecord,
  SandboxLeaseRecord,
} from "../application/ports";
import type { ProjectFilesFailure } from "../application/project-files";
import type { DiagnosticContext } from "../observability/contract";
import type {
  AgentRunResponse,
  MessageResponse,
  ProjectResponse,
  SandboxLeaseResponse,
} from "../shared/api";
import type { AppEnv } from "./env";
import { renderApiError } from "./http/api-errors";
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

export function requestDiagnosticContext(c: AppContext): DiagnosticContext {
  return { requestId: c.get("requestId") };
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
    failureCode: run.failureCode,
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
  return renderApiError(c, "auth.unauthorized");
}

export function validationError(c: AppContext) {
  return renderApiError(c, "request.invalid");
}

export function notFound(c: AppContext) {
  return renderApiError(c, "resource.not_found");
}

export function projectBusy(c: AppContext) {
  return renderApiError(c, "project.busy");
}

export function agentRuntimeUnavailable(c: AppContext) {
  return renderApiError(c, "agent_runtime.unavailable");
}

export function runsDisabled(c: AppContext) {
  return renderApiError(c, "run.creation_disabled");
}

export function projectFilesError(c: AppContext, error: ProjectFilesFailure["kind"]) {
  switch (error) {
    case "file_too_large":
      return renderApiError(c, "file.too_large");
    case "path_conflict":
      return renderApiError(c, "file.already_exists");
    case "path_not_found":
      return renderApiError(c, "project_path.not_found");
    case "project_busy":
      return renderApiError(c, "project.busy");
    case "sandbox_unavailable":
      return renderApiError(c, "sandbox.not_active");
    case "unsupported_file":
      return renderApiError(c, "file.content_unsupported");
    case "unsupported_path":
      return renderApiError(c, "project_path.unsupported");
    case "provider_error":
      return sandboxProviderUnavailable(c);
  }
}

export function internalError(c: AppContext) {
  return renderApiError(c, "internal.unexpected");
}

export function serviceUnavailable(c: AppContext) {
  return renderApiError(c, "service.unavailable");
}

export function sandboxProviderUnavailable(c: AppContext) {
  return renderApiError(c, "sandbox.provider_unavailable");
}

function toSandboxLeaseResponse(sandboxLease: SandboxLeaseRecord): SandboxLeaseResponse {
  return {
    id: sandboxLease.id,
    runtimeId: sandboxLease.runtimeId,
    status: sandboxLease.status,
    updatedAt: sandboxLease.updatedAt,
  };
}
