import type { Hono } from "hono";

import type { ProjectDirectoryResponse, ProjectFileResponse } from "../shared/api";
import type { AppEnv } from "./env";
import type { ProjectApiDependencies } from "./project-api-dependencies";
import {
  notFound,
  projectFilesError,
  requestDiagnosticContext,
  requireAuthenticatedUser,
  unauthorized,
} from "./project-api-support";

export function registerProjectFilesRoutes(
  api: Hono<AppEnv>,
  dependencies: ProjectApiDependencies,
) {
  api.get("/projects/:projectId/files", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const services = dependencies.createServices(c.env, requestDiagnosticContext(c));
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

    const services = dependencies.createServices(c.env, requestDiagnosticContext(c));
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
}
