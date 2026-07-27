import { Hono, type Context } from "hono";

import type {
  ProjectChangeDetails,
  ProjectChangesFailure,
  ProjectChangesSnapshot,
} from "../application/project-changes";
import type { DiagnosticContext } from "../observability/contract";
import type {
  ProjectChangeDiffResponse,
  ProjectChangeEntryResponse,
  ProjectChangesResponse,
} from "../shared/api";
import { getAuthenticatedUser, type AuthenticatedUser } from "./auth-context";
import type { AppBindings, AppEnv } from "./env";
import { renderApiError } from "./http/api-errors";
import { createServerServices, type ServerServices } from "./services";

type AppContext = Context<AppEnv>;
type ChangesServices = Pick<ServerServices, "projectChanges" | "projects">;

export type ChangesApiDependencies = {
  createServices(env: AppBindings, diagnosticContext?: DiagnosticContext): ChangesServices;
  getAuthenticatedUser(env: AppBindings, headers: Headers): Promise<AuthenticatedUser | null>;
};

const defaultDependencies: ChangesApiDependencies = {
  createServices: createServerServices,
  getAuthenticatedUser,
};

export function createChangesApi(overrides: Partial<ChangesApiDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  const api = new Hono<AppEnv>();

  api.use("*", async (c, next) => {
    await next();
    c.header("cache-control", "private, no-store");
  });

  api.get("/projects/:projectId/changes", async (c) => {
    const access = await getOwnedProject(c, dependencies);
    if (access.kind !== "ok") {
      return accessError(c, access.kind);
    }

    const result = await access.services.projectChanges.list(access.projectId);
    if (result.kind !== "ok") {
      return changesError(c, result);
    }
    return c.json<ProjectChangesResponse>(toProjectChangesResponse(result.changes));
  });

  api.get("/projects/:projectId/changes/content", async (c) => {
    const access = await getOwnedProject(c, dependencies);
    if (access.kind !== "ok") {
      return accessError(c, access.kind);
    }

    const result = await access.services.projectChanges.read(access.projectId, c.req.query("path"));
    if (result.kind !== "ok") {
      return changesError(c, result);
    }
    return c.json<ProjectChangeDiffResponse>(toProjectChangeDiffResponse(result.details));
  });

  return api;
}

async function getOwnedProject(c: AppContext, dependencies: ChangesApiDependencies) {
  const user = await dependencies.getAuthenticatedUser(c.env, c.req.raw.headers);
  if (!user) {
    return { kind: "unauthorized" as const };
  }

  const services = dependencies.createServices(c.env, {
    requestId: c.get("requestId"),
  });
  const projectId = c.req.param("projectId");
  if (!projectId) {
    return { kind: "not_found" as const };
  }
  const project = await services.projects.findOwnedById(projectId, user.id);
  return project
    ? { kind: "ok" as const, projectId: project.id, services }
    : { kind: "not_found" as const };
}

function accessError(c: AppContext, kind: "not_found" | "unauthorized") {
  return kind === "unauthorized"
    ? renderApiError(c, "auth.unauthorized")
    : renderApiError(c, "resource.not_found");
}

function changesError(c: AppContext, failure: ProjectChangesFailure) {
  switch (failure.kind) {
    case "path_not_found":
      return renderApiError(c, "project_path.not_found");
    case "project_busy":
      return renderApiError(c, "project.busy");
    case "sandbox_unavailable":
      return renderApiError(c, "sandbox.not_active");
    case "unsupported_path":
      return renderApiError(c, "project_path.unsupported");
    case "provider_error":
      return renderApiError(c, "sandbox.provider_unavailable");
    case "runtime_mismatch":
      return renderApiError(c, "internal.unexpected");
  }
}

function toProjectChangesResponse(changes: ProjectChangesSnapshot): ProjectChangesResponse {
  return {
    entries: changes.entries.map(toProjectChangeEntryResponse),
    repository: changes.repository,
    truncated: changes.truncated,
    unsupportedEntries: changes.unsupportedEntries,
  };
}

function toProjectChangeDiffResponse(details: ProjectChangeDetails): ProjectChangeDiffResponse {
  return {
    change: toProjectChangeEntryResponse(details.change),
    staged: details.staged
      ? {
          content: details.staged.content,
          truncated: details.staged.truncated,
        }
      : null,
    unstaged: details.unstaged
      ? {
          content: details.unstaged.content,
          truncated: details.unstaged.truncated,
        }
      : null,
  };
}

function toProjectChangeEntryResponse(
  change: ProjectChangeDetails["change"],
): ProjectChangeEntryResponse {
  return {
    path: change.path,
    previousPath: change.previousPath,
    stagedKind: change.stagedKind,
    unstagedKind: change.unstagedKind,
  };
}
