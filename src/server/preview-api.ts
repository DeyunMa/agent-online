import { Hono, type Context } from "hono";

import type { ProjectPreviewStatus } from "../application/project-preview";
import type {
  ApiErrorResponse,
  ProjectPreviewResponse,
} from "../shared/api";
import {
  getAuthenticatedUser,
  type AuthenticatedUser,
} from "./auth-context";
import type { AppBindings, AppEnv } from "./env";
import {
  createPreviewCapabilityCodec,
  previewContentBasePath,
  type PreviewCapabilityClaims,
} from "./preview-capability";
import {
  createServerServices,
  type ServerServices,
} from "./services";

type AppContext = Context<AppEnv>;

export type PreviewApiDependencies = {
  createServices(env: AppBindings): ServerServices;
  getAuthenticatedUser(
    env: AppBindings,
    headers: Headers,
  ): Promise<AuthenticatedUser | null>;
  now(): Date;
};

const defaultDependencies: PreviewApiDependencies = {
  createServices: createServerServices,
  getAuthenticatedUser,
  now: () => new Date(),
};

const previewContentCsp = [
  "default-src 'self' data: blob:",
  "base-uri 'self'",
  "connect-src 'none'",
  "font-src 'self' data:",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "frame-src 'none'",
  "img-src 'self' data: blob:",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline' data:",
  "worker-src blob:",
].join("; ");

export function createPreviewApi(
  overrides: Partial<PreviewApiDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };
  const api = new Hono<AppEnv>();

  api.get("/projects/:projectId/preview", async (c) => {
    const access = await getOwnedProject(c, dependencies);
    if (access.kind !== "ok") {
      return accessError(c, access.kind);
    }

    const status = await access.services.projectPreviews.inspect(
      access.projectId,
    );
    if (status.kind === "provider_error") {
      return previewUnavailable(c);
    }
    if (status.kind === "runtime_mismatch") {
      return internalError(c);
    }

    return c.json(
      await toPreviewResponse(c.env, access.projectId, status),
    );
  });

  api.post("/projects/:projectId/preview/start", async (c) => {
    if (!isSameOrigin(c.req.raw)) {
      return forbidden(c);
    }
    const access = await getOwnedProject(c, dependencies);
    if (access.kind !== "ok") {
      return accessError(c, access.kind);
    }

    const result = await access.services.projectPreviews.start(
      access.projectId,
    );
    if (result.kind === "project_busy") {
      return projectBusy(c);
    }
    if (result.kind === "sandbox_unavailable") {
      return sandboxUnavailable(c);
    }
    if (result.kind === "runtime_mismatch") {
      return internalError(c);
    }
    if (result.kind === "provider_error") {
      return previewUnavailable(c);
    }

    return c.json(
      await toPreviewResponse(c.env, access.projectId, result.status),
      201,
    );
  });

  api.post("/projects/:projectId/preview/stop", async (c) => {
    if (!isSameOrigin(c.req.raw)) {
      return forbidden(c);
    }
    const access = await getOwnedProject(c, dependencies);
    if (access.kind !== "ok") {
      return accessError(c, access.kind);
    }

    const result = await access.services.projectPreviews.stop(
      access.projectId,
    );
    if (result.kind === "project_busy") {
      return projectBusy(c);
    }
    if (result.kind === "provider_error") {
      return previewUnavailable(c);
    }

    return c.json<ProjectPreviewResponse>({
      contentUrl: null,
      expiresAt: null,
      status: "stopped",
    });
  });

  const contentHandler = async (c: AppContext) => {
    const projectId = c.req.param("projectId");
    const token = c.req.param("token");
    if (!projectId || !token) {
      return notFound(c);
    }
    const claims = await verifyContentCapability(
      c.env,
      token,
      projectId,
      dependencies.now,
    );
    if (!claims) {
      return notFound(c);
    }

    const upstreamPath = parseUpstreamPath(
      c.req.raw,
      projectId,
      token,
    );
    if (!upstreamPath) {
      return notFound(c);
    }
    const result = await dependencies
      .createServices(c.env)
      .projectPreviews.fetch(projectId, claims.previewSessionId, {
        headers: pickPreviewRequestHeaders(c.req.raw.headers),
        method: c.req.method as "GET" | "HEAD",
        pathAndQuery: upstreamPath,
      });
    if (result.kind === "not_found") {
      return notFound(c);
    }
    if (result.kind === "sandbox_unavailable") {
      return sandboxUnavailable(c);
    }
    if (result.kind === "runtime_mismatch") {
      return internalError(c);
    }
    if (result.kind === "provider_error") {
      return previewUnavailable(c);
    }

    const baseUrl = previewContentBasePath(
      projectId,
      token,
    );
    return preparePreviewResponse(result.response, baseUrl);
  };

  api.on(
    ["GET", "HEAD"],
    "/projects/:projectId/preview/content/:token",
    contentHandler,
  );
  api.on(
    ["GET", "HEAD"],
    "/projects/:projectId/preview/content/:token/*",
    contentHandler,
  );

  return api;
}

async function getOwnedProject(
  c: AppContext,
  dependencies: PreviewApiDependencies,
) {
  const user = await dependencies.getAuthenticatedUser(
    c.env,
    c.req.raw.headers,
  );
  if (!user) {
    return { kind: "unauthorized" as const };
  }
  const services = dependencies.createServices(c.env);
  const projectId = c.req.param("projectId");
  if (!projectId) {
    return { kind: "not_found" as const };
  }
  const project = await services.projects.findOwnedById(projectId, user.id);
  return project
    ? { kind: "ok" as const, projectId: project.id, services }
    : { kind: "not_found" as const };
}

async function toPreviewResponse(
  env: AppBindings,
  projectId: string,
  status: ProjectPreviewStatus,
): Promise<ProjectPreviewResponse> {
  if (status.kind !== "running") {
    return {
      contentUrl: null,
      expiresAt: status.expiresAt,
      status: status.kind,
    };
  }

  const codec = createPreviewCapabilityCodec({
    now: () => new Date(status.issuedAt),
    secret: requireSecret(env.BETTER_AUTH_SECRET),
  });
  const token = await codec.issue({
    expiresAt: new Date(status.expiresAt),
    issuedAt: new Date(status.issuedAt),
    previewSessionId: status.sessionId,
    projectId,
  });
  return {
    contentUrl: previewContentBasePath(projectId, token),
    expiresAt: status.expiresAt,
    status: "running",
  };
}

async function verifyContentCapability(
  env: AppBindings,
  token: string,
  projectId: string,
  now: () => Date,
): Promise<PreviewCapabilityClaims | null> {
  try {
    const claims = await createPreviewCapabilityCodec({
      now,
      secret: requireSecret(env.BETTER_AUTH_SECRET),
    }).verify(token);
    return claims?.projectId === projectId ? claims : null;
  } catch {
    return null;
  }
}

function parseUpstreamPath(
  request: Request,
  projectId: string,
  token: string,
) {
  const url = new URL(request.url);
  const prefix =
    `/api/projects/${encodeURIComponent(projectId)}` +
    `/preview/content/${encodeURIComponent(token)}`;
  if (
    url.pathname !== prefix &&
    !url.pathname.startsWith(`${prefix}/`)
  ) {
    return null;
  }
  const path = url.pathname.slice(prefix.length) || "/";
  if (
    path.length > 2_048 ||
    /[\r\n\u0000]/.test(path) ||
    path.split("/").some((segment) => segment === "..")
  ) {
    return null;
  }
  return `${url.pathname}${url.search}`;
}

function pickPreviewRequestHeaders(headers: Headers) {
  const result: Record<string, string> = {};
  for (const name of [
    "accept",
    "accept-encoding",
    "accept-language",
    "if-modified-since",
    "if-none-match",
    "range",
  ]) {
    const value = headers.get(name);
    if (value) {
      result[name] = value;
    }
  }
  return result;
}

function preparePreviewResponse(upstream: Response, baseUrl: string) {
  const headers = new Headers();
  for (const name of [
    "accept-ranges",
    "content-range",
    "content-type",
    "etag",
    "last-modified",
  ]) {
    const value = upstream.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  headers.set("access-control-allow-origin", "*");
  headers.set("cache-control", "no-store");
  headers.set("content-security-policy", previewContentCsp);
  headers.set("cross-origin-resource-policy", "cross-origin");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");

  if (upstream.status >= 300 && upstream.status < 400) {
    const location = rewriteRedirectLocation(
      upstream.headers.get("location"),
      baseUrl,
    );
    if (!location) {
      return new Response(
        JSON.stringify({ error: "preview_unavailable" }),
        {
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
          status: 502,
        },
      );
    }
    headers.set("location", location);
  }

  const response = new Response(upstream.body, {
    headers,
    status: upstream.status,
    statusText: upstream.statusText,
  });
  if (
    upstream.body &&
    upstream.headers.get("content-type")?.toLowerCase().includes("text/html")
  ) {
    return rewritePreviewHtml(response, baseUrl);
  }
  return response;
}

function rewriteRedirectLocation(
  location: string | null,
  baseUrl: string,
) {
  if (!location || /^[a-z][a-z0-9+.-]*:/i.test(location) || location.startsWith("//")) {
    return null;
  }
  if (location.startsWith(baseUrl)) {
    return location;
  }
  const parsed = new URL(location, "https://preview.invalid/");
  return `${baseUrl.replace(/\/$/, "")}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function rewritePreviewHtml(response: Response, baseUrl: string) {
  const rootRelativeAttributes = [
    ["a", "href"],
    ["form", "action"],
    ["iframe", "src"],
    ["img", "src"],
    ["link", "href"],
    ["script", "src"],
    ["source", "src"],
  ] as const;
  let rewriter = new HTMLRewriter()
    .on("base", {
      element(element) {
        element.remove();
      },
    })
    .on("head", {
      element(element) {
        element.prepend(`<base href="${baseUrl}">`, { html: true });
      },
    });

  for (const [selector, attribute] of rootRelativeAttributes) {
    rewriter = rewriter.on(selector, {
      element(element) {
        const value = element.getAttribute(attribute);
        if (value) {
          element.setAttribute(
            attribute,
            rewriteRootRelativeUrl(value, baseUrl),
          );
        }
      },
    });
  }
  return rewriter.transform(response);
}

function rewriteRootRelativeUrl(value: string, baseUrl: string) {
  if (value.startsWith(baseUrl)) {
    return value;
  }
  return value.startsWith("/") && !value.startsWith("//")
    ? `${baseUrl.replace(/\/$/, "")}${value}`
    : value;
}

function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

function requireSecret(value: string | undefined) {
  if (!value) {
    throw new Error("BETTER_AUTH_SECRET is required");
  }
  return value;
}

function accessError(
  c: AppContext,
  kind: "not_found" | "unauthorized",
) {
  return kind === "unauthorized" ? unauthorized(c) : notFound(c);
}

function unauthorized(c: AppContext) {
  return error(c, "unauthorized", 401);
}

function forbidden(c: AppContext) {
  return error(c, "forbidden", 403);
}

function notFound(c: AppContext) {
  return error(c, "not_found", 404);
}

function projectBusy(c: AppContext) {
  return error(c, "project_busy", 409);
}

function sandboxUnavailable(c: AppContext) {
  return error(c, "sandbox_unavailable", 409);
}

function previewUnavailable(c: AppContext) {
  return error(c, "preview_unavailable", 503);
}

function internalError(c: AppContext) {
  return error(c, "internal_error", 500);
}

function error(
  c: AppContext,
  code: ApiErrorResponse["error"],
  status: 401 | 403 | 404 | 409 | 500 | 503,
) {
  return c.json<ApiErrorResponse>(
    {
      error: code,
      requestId: c.get("requestId"),
    },
    status,
  );
}
