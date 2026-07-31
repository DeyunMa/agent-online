import type { Hono } from "hono";

import { maxProjectFileUploadBytes } from "../application/project-files";
import type {
  ProjectDirectoryResponse,
  ProjectFileResponse,
  ProjectFileUploadResponse,
} from "../shared/api";
import type { AppEnv } from "./env";
import type { ProjectApiDependencies } from "./project-api-dependencies";
import {
  notFound,
  projectFilesError,
  requestDiagnosticContext,
  requireAuthenticatedUser,
  unauthorized,
  validationError,
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
    const project = await services.projectReads.findOwnedProject(c.req.param("projectId"), user.id);
    if (!project) {
      return notFound(c);
    }

    const result = await services.projectFiles.list(project.id, c.req.query("path"));
    if (result.kind !== "ok") {
      return projectFilesError(c, result.kind);
    }
    return c.json<ProjectDirectoryResponse>(result.directory);
  });

  api.post("/projects/:projectId/files", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const services = dependencies.createServices(c.env, requestDiagnosticContext(c));
    const project = await services.projectReads.findOwnedProject(c.req.param("projectId"), user.id);
    if (!project) {
      return notFound(c);
    }

    const file = await readUploadedFile(c.req.raw);
    if (!file) {
      return validationError(c);
    }
    if (file.size > maxProjectFileUploadBytes) {
      return projectFilesError(c, "file_too_large");
    }

    const result = await services.projectFiles.upload(project.id, {
      bytes: new Uint8Array(await file.arrayBuffer()),
      name: file.name,
    });
    if (result.kind !== "ok") {
      return projectFilesError(c, result.kind);
    }
    return c.json<ProjectFileUploadResponse>(result.file, 201);
  });

  api.get("/projects/:projectId/files/content", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const services = dependencies.createServices(c.env, requestDiagnosticContext(c));
    const project = await services.projectReads.findOwnedProject(c.req.param("projectId"), user.id);
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

async function readUploadedFile(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
    return null;
  }

  try {
    const values = (await request.formData()).getAll("file");
    return values.length === 1 && values[0] instanceof File ? values[0] : null;
  } catch {
    return null;
  }
}
