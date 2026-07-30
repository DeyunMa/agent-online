import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { ProjectRecord } from "../application/ports";
import type { FetchProjectPreviewResult } from "../application/project-preview";
import type { SandboxPreviewRequest } from "../runtime/contract";
import type { ProjectPreviewResponse } from "../shared/api";
import type { AppEnv } from "./env";
import {
  createPreviewApi,
  isViteClientResourcePath,
  type PreviewApiDependencies,
} from "./preview-api";
import type { ServerServices } from "./services";

const user = { email: "user@example.test", id: "user-1" };
const now = new Date("2026-07-26T08:00:00.000Z");
const expiresAt = "2026-07-26T08:30:00.000Z";
const betterAuthTestSecret = "preview-test-secret-with-at-least-thirty-two-characters";
const project: ProjectRecord = {
  createdAt: now.toISOString(),
  defaultAgentRuntimeId: "pi",
  id: "project-1",
  title: "Preview project",
  updatedAt: now.toISOString(),
  userId: user.id,
};

describe("Preview API", () => {
  it("recognizes only the fixed Vite client module for removal", () => {
    const baseUrl = "/api/projects/project-1/preview/content/capability/";

    expect(isViteClientResourcePath(`${baseUrl}@vite/client`, baseUrl)).toBe(true);
    expect(isViteClientResourcePath("/@vite/client?v=1", baseUrl)).toBe(true);
    expect(isViteClientResourcePath("/src/main.js", baseUrl)).toBe(false);
  });

  it("issues an opaque same-origin content URL without provider details", async () => {
    const fixture = createFixture();
    const response = await fixture.app.request(
      "https://agent-online.test/api/projects/project-1/preview",
      undefined,
      fixture.env,
    );
    const body = await response.json<ProjectPreviewResponse>();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      expiresAt,
      status: "running",
    });
    expect(body.contentUrl).toMatch(/^\/api\/projects\/project-1\/preview\/content\/[^/]+\/$/);
    expect(JSON.stringify(body)).not.toContain("sandbox-provider");
    expect(JSON.stringify(body)).not.toContain("e2b.app");
    expect(JSON.stringify(body)).not.toContain("3000");
  });

  it("requires same-origin and ownership before starting provider state", async () => {
    const crossOrigin = createFixture();
    const missing = createFixture({ projectOwned: false });

    const crossOriginResponse = await crossOrigin.app.request(
      "https://agent-online.test/api/projects/project-1/preview/start",
      {
        headers: { origin: "https://attacker.example" },
        method: "POST",
      },
      crossOrigin.env,
    );
    const missingResponse = await missing.app.request(
      "https://agent-online.test/api/projects/project-1/preview/start",
      {
        headers: { origin: "https://agent-online.test" },
        method: "POST",
      },
      missing.env,
    );

    expect(crossOriginResponse.status).toBe(403);
    expect(missingResponse.status).toBe(404);
    expect(crossOrigin.start).not.toHaveBeenCalled();
    expect(missing.start).not.toHaveBeenCalled();
  });

  it("verifies the platform capability and forwards only safe request headers", async () => {
    const fixture = createFixture();
    const statusResponse = await fixture.app.request(
      "https://agent-online.test/api/projects/project-1/preview",
      undefined,
      fixture.env,
    );
    const status = await statusResponse.json<ProjectPreviewResponse>();
    const response = await fixture.app.request(
      `https://agent-online.test${status.contentUrl}assets/app.css?v=1`,
      {
        headers: {
          accept: "text/css",
          authorization: "Bearer browser-secret",
          cookie: "session=browser-secret",
          range: "bytes=0-100",
        },
      },
      fixture.env,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("body { color: black; }");
    expect(fixture.fetchPreview).toHaveBeenCalledWith("project-1", "preview-1", {
      headers: {
        accept: "text/css",
        range: "bytes=0-100",
      },
      method: "GET",
      pathAndQuery: `${status.contentUrl}assets/app.css?v=1`,
    });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-provider-host")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'none'");
  });

  it("replaces only Vite's client module with a no-network style runtime", async () => {
    const fixture = createFixture();
    const statusResponse = await fixture.app.request(
      "https://agent-online.test/api/projects/project-1/preview",
      undefined,
      fixture.env,
    );
    const status = await statusResponse.json<ProjectPreviewResponse>();
    const response = await fixture.app.request(
      `https://agent-online.test${status.contentUrl}@vite/client`,
      undefined,
      fixture.env,
    );
    const source = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(source).toContain("export function createHotContext()");
    expect(source).toContain("export function updateStyle(id, content)");
    expect(source).toContain("export function removeStyle(id)");
    expect(source).not.toContain("sandbox-provider");
    expect(fixture.fetchPreview).toHaveBeenCalledTimes(1);
  });

  it("rejects a tampered or stopped content capability", async () => {
    const fixture = createFixture();
    const statusResponse = await fixture.app.request(
      "https://agent-online.test/api/projects/project-1/preview",
      undefined,
      fixture.env,
    );
    const status = await statusResponse.json<ProjectPreviewResponse>();
    const tampered = await fixture.app.request(
      `https://agent-online.test${status.contentUrl}x`,
      undefined,
      {
        ...fixture.env,
        BETTER_AUTH_SECRET: `${fixture.env.BETTER_AUTH_SECRET}tampered`,
      },
    );
    fixture.fetchPreview.mockResolvedValueOnce({ kind: "not_found" });
    const stopped = await fixture.app.request(
      `https://agent-online.test${status.contentUrl}x`,
      undefined,
      fixture.env,
    );

    expect(tampered.status).toBe(404);
    expect(stopped.status).toBe(404);
  });
});

function createFixture(options: { authenticated?: boolean; projectOwned?: boolean } = {}) {
  const inspect = vi.fn(async () => ({
    expiresAt,
    issuedAt: now.toISOString(),
    kind: "running" as const,
    sessionId: "preview-1",
  }));
  const start = vi.fn(async () => ({
    kind: "started" as const,
    status: {
      expiresAt,
      issuedAt: now.toISOString(),
      kind: "running" as const,
      sessionId: "preview-1",
    },
  }));
  const stop = vi.fn(async () => ({ kind: "stopped" as const }));
  const fetchPreview = vi.fn(
    async (
      _projectId: string,
      _previewSessionId: string,
      _request: SandboxPreviewRequest,
    ): Promise<FetchProjectPreviewResult> =>
      Promise.resolve({
        kind: "ok" as const,
        response: new Response("body { color: black; }", {
          headers: {
            "content-type": "text/css",
            "set-cookie": "provider-secret=1",
            "x-provider-host": "sandbox-provider.e2b.app",
          },
        }),
      }),
  );
  const services = {
    projectPreviews: {
      fetch: fetchPreview,
      inspect,
      start,
      stop,
    },
    projectReads: {
      findOwnedProject: vi.fn(async () => (options.projectOwned === false ? null : project)),
    },
  } as unknown as ServerServices;
  const dependencies: Partial<PreviewApiDependencies> = {
    createServices: () => services,
    getAuthenticatedUser: async () => (options.authenticated === false ? null : user),
    now: () => now,
  };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "request-1");
    await next();
  });
  app.route("/api", createPreviewApi(dependencies));

  return {
    app,
    env: {
      BETTER_AUTH_SECRET: betterAuthTestSecret,
    } as AppEnv["Bindings"],
    fetchPreview,
    start,
  };
}
