import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { AppEnv } from "../env";
import { classifyRoute, requestMeasurement } from "./request-measurement";

it("emits only categorical HTTP labels without URL or body content", async () => {
  const report = vi.fn();
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "request-1");
    await next();
  });
  app.use(
    "*",
    requestMeasurement(() => ({ report })),
  );
  app.get("/api/projects/:id/files/content", (c) =>
    c.json({ content: "private-file-content" }, 403),
  );
  const response = await app.request(
    "/api/projects/private-project/files/content?path=private-path",
  );
  expect(response.status).toBe(403);
  expect(report).toHaveBeenCalledWith({
    event: "performance.measured",
    operation: "http",
    stage: "request",
    route: "files",
    httpStatus: 403,
    outcome: "rejected",
    durationMs: expect.any(Number),
  });
  expect(JSON.stringify(report.mock.calls)).not.toContain("private");
});

it("observes normalized error responses without changing them", async () => {
  const report = vi.fn();
  const app = new Hono<AppEnv>();
  app.use(
    "*",
    requestMeasurement(() => ({ report })),
  );
  app.get("/api/usage", () => {
    throw new Error("private upstream failure");
  });
  app.onError((_, c) => c.json({ error: "internal" }, 500));
  expect((await app.request("/api/usage")).status).toBe(500);
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({ httpStatus: 500, outcome: "failed", route: "usage" }),
  );
});

it("classifies the gateway and unknown paths without exposing input", () => {
  expect(classifyRoute("/api/model-gateway/v1/chat/completions")).toBe("model_gateway");
  expect(classifyRoute("/api/auth/sign-in/email")).toBe("auth");
  expect(classifyRoute("/private/path")).toBe("other");
});
