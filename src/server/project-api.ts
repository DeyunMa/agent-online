import { Hono } from "hono";
import { z } from "zod";

import { registerAgentRunRoutes } from "./agent-run-api";
import type { AppEnv } from "./env";
import {
  type ProjectApiDependencies,
  resolveProjectApiDependencies,
} from "./project-api-dependencies";
import { registerProjectFilesRoutes } from "./project-files-api";
import {
  notFound,
  parseRequest,
  projectBusy,
  requestDiagnosticContext,
  requireAuthenticatedUser,
  sandboxProviderUnavailable,
  serviceUnavailable,
  toMessageResponse,
  toProjectResponse,
  unauthorized,
  validationError,
} from "./project-api-support";

const createProjectSchema = z.object({
  title: z.string().trim().min(1).max(120),
});
const updateProjectSchema = createProjectSchema;

export type { ProjectApiDependencies } from "./project-api-dependencies";

export function createProjectApi(overrides: Partial<ProjectApiDependencies> = {}) {
  const dependencies = resolveProjectApiDependencies(overrides);
  const api = new Hono<AppEnv>();

  api.get("/projects", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const services = dependencies.createServices(c.env, requestDiagnosticContext(c));
    const projects = await services.projectReads.listOwnedProjects(user.id);

    return c.json(projects.map(({ lease, project }) => toProjectResponse(project, lease)));
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

    const project = await dependencies
      .createServices(c.env, requestDiagnosticContext(c))
      .projectManagement.create({
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

    const services = dependencies.createServices(c.env, requestDiagnosticContext(c));
    const project = await services.projectReads.findOwnedProjectWithLease(
      c.req.param("projectId"),
      user.id,
    );
    if (!project) {
      return notFound(c);
    }

    return c.json(toProjectResponse(project.project, project.lease));
  });

  api.patch("/projects/:projectId", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const input = await parseRequest(c, updateProjectSchema);
    if (!input) {
      return validationError(c);
    }

    const services = dependencies.createServices(c.env, requestDiagnosticContext(c));
    const renamed = await services.projectManagement.rename({
      projectId: c.req.param("projectId"),
      title: input.title,
      userId: user.id,
    });
    if (renamed.kind === "not_found") {
      return notFound(c);
    }

    const project = await services.projectReads.findOwnedProjectWithLease(
      renamed.project.id,
      user.id,
    );
    return c.json(toProjectResponse(renamed.project, project?.lease ?? null));
  });

  api.delete("/projects/:projectId", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const deleted = await dependencies
      .createServices(c.env, requestDiagnosticContext(c))
      .projectManagement.delete({
        projectId: c.req.param("projectId"),
        userId: user.id,
      });
    if (deleted.kind === "not_found") {
      return notFound(c);
    }
    if (deleted.kind === "project_busy") {
      return projectBusy(c);
    }
    if (deleted.kind === "provider_error") {
      return sandboxProviderUnavailable(c);
    }
    if (deleted.kind === "conflict") {
      return serviceUnavailable(c);
    }

    return c.body(null, 204);
  });

  api.post("/projects/:projectId/sandbox/stop", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const services = dependencies.createServices(c.env, requestDiagnosticContext(c));
    const project = await services.projectReads.findOwnedProject(c.req.param("projectId"), user.id);
    if (!project) {
      return notFound(c);
    }

    const stopped = await services.projectSandboxes.stop(project.id);
    if (stopped.kind === "project_busy") {
      return projectBusy(c);
    }
    if (stopped.kind === "provider_error") {
      return sandboxProviderUnavailable(c);
    }
    if (stopped.kind === "conflict") {
      return serviceUnavailable(c);
    }

    return c.json(toProjectResponse(project, stopped.lease));
  });

  api.get("/projects/:projectId/messages", async (c) => {
    const user = await requireAuthenticatedUser(c, dependencies);
    if (!user) {
      return unauthorized(c);
    }

    const services = dependencies.createServices(c.env, requestDiagnosticContext(c));
    const messages = await services.projectReads.listOwnedMessages(
      c.req.param("projectId"),
      user.id,
    );
    if (!messages) {
      return notFound(c);
    }

    return c.json(messages.map(toMessageResponse));
  });

  registerProjectFilesRoutes(api, dependencies);
  registerAgentRunRoutes(api, dependencies);

  return api;
}
