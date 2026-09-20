import { afterEach, describe, expect, it, vi } from "vitest";

import { browserApi, subscribeToAgentRun } from "./api";

const project = {
  createdAt: "2026-09-08T00:00:00.000Z",
  defaultAgentRuntimeId: "pi",
  id: "project_1",
  sandboxLease: null,
  title: "Demo",
  updatedAt: "2026-09-08T00:00:00.000Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("browser API response contracts", () => {
  it("rejects invalid successful JSON without including its contents in the error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { ...project, title: { privateValue: "private-provider-detail" } },
            { headers: { "x-request-id": "request_1" } },
          ),
        ),
    );
    const error = await browserApi.getProject("project_1").catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "network_error", requestId: "request_1", status: 200 });
    expect(String(error)).not.toContain("private-provider-detail");
  });

  it("strips unknown properties at nested public response boundaries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          ...project,
          userId: "private-owner",
          sandboxLease: {
            id: "lease_1",
            runtimeId: "e2b",
            status: "idle",
            updatedAt: project.updatedAt,
            providerRef: "private-provider-detail",
          },
        }),
      ),
    );
    const result = await browserApi.getProject("project_1");
    expect(result).not.toHaveProperty("userId");
    expect(result.sandboxLease).not.toHaveProperty("providerRef");
  });

  it("allows 204 only for endpoints declaring an empty response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => new Response(null, { status: 204 })),
    );
    await expect(browserApi.deleteProject("project_1")).resolves.toBeUndefined();
    await expect(browserApi.getProject("project_1")).rejects.toMatchObject({
      code: "network_error",
    });
  });

  it.each(["", "private malformed body", "null", "{}"])(
    "rejects non-contract delete responses: %j",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
      await expect(browserApi.deleteProject("project_1")).rejects.toMatchObject({
        code: "network_error",
      });
    },
  );

  it("preserves the public error code, retryability and request ID", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: { code: "project.busy", retryable: true },
            requestId: "request_2",
          },
          { status: 409 },
        ),
      ),
    );
    await expect(browserApi.getProject("project_1")).rejects.toMatchObject({
      code: "project.busy",
      retryable: true,
      requestId: "request_2",
      status: 409,
    });
  });

  it("lets fetch choose the multipart boundary for file uploads", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ name: "a.txt", path: "a.txt", size: 1 }));
    vi.stubGlobal("fetch", fetch);
    await browserApi.uploadProjectFile("project_1", new File(["a"], "a.txt"));
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBeInstanceOf(FormData);
    expect(new Headers(init.headers).has("content-type")).toBe(false);
    expect(init.credentials).toBe("same-origin");
  });
});

describe("Run stream contracts", () => {
  it("reports permanently closed streams so HTTP polling can recover", () => {
    const source = {
      close: vi.fn(),
      onmessage: null,
      onerror: null as (() => void) | null,
      readyState: 2,
    };
    vi.stubGlobal(
      "EventSource",
      Object.assign(
        vi.fn(function MockEventSource() {
          return source;
        }),
        { CLOSED: 2 },
      ),
    );
    const onError = vi.fn();
    subscribeToAgentRun("project", "run", { onError, onEvent: vi.fn() });
    source.onerror?.();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "network_error" }));
  });

  it("ignores malformed events and delivers validated events with unknown fields removed", () => {
    const source = {
      close: vi.fn(),
      onmessage: null as ((event: { data: string }) => void) | null,
      onerror: null,
      readyState: 1,
    };
    vi.stubGlobal(
      "EventSource",
      Object.assign(
        vi.fn(function MockEventSource() {
          return source;
        }),
        { CLOSED: 2 },
      ),
    );
    const onEvent = vi.fn();
    subscribeToAgentRun("project_1", "run_1", { onError: vi.fn(), onEvent });
    for (const data of [
      "invalid",
      JSON.stringify({ type: "run.status", sequence: -1, status: "running" }),
      JSON.stringify({ type: "run.status", sequence: 0, status: "unknown" }),
    ]) {
      source.onmessage?.({ data });
    }
    expect(onEvent).not.toHaveBeenCalled();
    source.onmessage?.({
      data: JSON.stringify({
        type: "run.status",
        sequence: 0,
        status: "running",
        providerRef: "private",
      }),
    });
    expect(onEvent).toHaveBeenLastCalledWith({
      type: "run.status",
      sequence: 0,
      status: "running",
    });
    source.onmessage?.({
      data: JSON.stringify({
        type: "run.completed",
        sequence: 1,
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          modelRequestCount: 1,
          sandboxDurationMs: 10,
        },
      }),
    });
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(source.close).toHaveBeenCalledOnce();
  });
});
