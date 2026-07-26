import { describe, expect, it, vi } from "vitest";

import type { ProjectRecord } from "../application/ports";
import { createChangesApi } from "./changes-api";
import type { ServerServices } from "./services";

const user = { email: "owner@example.test", id: "user-1" };
const project: ProjectRecord = {
  createdAt: "2026-07-26T00:00:00.000Z",
  defaultAgentRuntimeId: "pi",
  id: "project-1",
  title: "Project",
  updatedAt: "2026-07-26T00:00:00.000Z",
  userId: user.id,
};

describe("Changes API", () => {
  it("requires authentication and Project ownership", async () => {
    const unauthenticated = createFixture({ authenticated: false });
    const missing = createFixture({ projectFound: false });

    const unauthenticatedResponse = await unauthenticated.api.request(
      "http://agent-online.test/projects/project-1/changes",
    );
    const missingResponse = await missing.api.request(
      "http://agent-online.test/projects/project-1/changes",
    );

    expect(unauthenticatedResponse.status).toBe(401);
    expect(missingResponse.status).toBe(404);
    expect(unauthenticated.list).not.toHaveBeenCalled();
    expect(missing.list).not.toHaveBeenCalled();
  });

  it("returns only the normalized current status", async () => {
    const fixture = createFixture();

    const response = await fixture.api.request(
      "http://agent-online.test/projects/project-1/changes",
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expect(body).toEqual({
      entries: [
        {
          path: "src/index.ts",
          previousPath: null,
          stagedKind: null,
          unstagedKind: "modified",
        },
      ],
      repository: true,
      truncated: false,
      unsupportedEntries: false,
    });
    expect(JSON.stringify(body)).not.toContain("sandbox-private");
  });

  it("passes only the requested path to the status-validating service", async () => {
    const fixture = createFixture();

    const response = await fixture.api.request(
      "http://agent-online.test/projects/project-1/changes/content?path=src%2Findex.ts",
    );

    expect(response.status).toBe(200);
    expect(fixture.read).toHaveBeenCalledWith(
      "project-1",
      "src/index.ts",
    );
    const body = await response.json();
    expect(body).toMatchObject({
      change: { path: "src/index.ts" },
      unstaged: { content: "@@ -1 +1 @@" },
    });
    expect(JSON.stringify(body)).not.toContain("sandbox-private");
  });

  it.each([
    ["project_busy", 409],
    ["sandbox_unavailable", 409],
    ["path_not_found", 404],
    ["unsupported_path", 400],
    ["provider_error", 503],
    ["runtime_mismatch", 500],
  ] as const)("maps %s without exposing failure details", async (kind, status) => {
    const fixture = createFixture({ failure: kind });

    const response = await fixture.api.request(
      "http://agent-online.test/projects/project-1/changes",
    );
    const body = await response.json();

    expect(response.status).toBe(status);
    expect(body).toMatchObject({
      error:
        kind === "provider_error" || kind === "runtime_mismatch"
          ? "internal_error"
          : kind,
    });
    expect(JSON.stringify(body)).not.toContain("provider");
  });
});

function createFixture(
  options: {
    authenticated?: boolean;
    failure?:
      | "path_not_found"
      | "project_busy"
      | "provider_error"
      | "runtime_mismatch"
      | "sandbox_unavailable"
      | "unsupported_path";
    projectFound?: boolean;
  } = {},
) {
  const change = {
    path: "src/index.ts",
    previousPath: null,
    providerRef: "sandbox-private",
    stagedKind: null,
    unstagedKind: "modified" as const,
  };
  const list = vi.fn(async () =>
    options.failure
      ? { kind: options.failure }
      : {
          changes: {
            entries: [change],
            repository: true,
            truncated: false,
            unsupportedEntries: false,
          },
          kind: "ok" as const,
        },
  );
  const read = vi.fn(async () => ({
    details: {
      change,
      staged: null,
      unstaged: {
        content: "@@ -1 +1 @@",
        truncated: false,
      },
    },
    kind: "ok" as const,
  }));
  const api = createChangesApi({
    createServices: () =>
      ({
        projectChanges: { list, read },
        projects: {
          findOwnedById: async () =>
            options.projectFound === false ? null : project,
        },
      }) as unknown as Pick<
        ServerServices,
        "projectChanges" | "projects"
      >,
    getAuthenticatedUser: async () =>
      options.authenticated === false ? null : user,
  });

  return { api, list, read };
}
