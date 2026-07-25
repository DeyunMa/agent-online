import { describe, expect, it } from "vitest";

import { app } from "./app";

describe("Worker API", () => {
  it("returns a health response", async () => {
    const response = await app.request("http://agent-online.test/api/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ name: "agent-online", status: "ok" });
  });

  it("exposes the installed default agent runtime", async () => {
    const response = await app.request("http://agent-online.test/api/runtime-config");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ defaultAgentRuntime: "pi", runtimeProvider: "fake" });
  });
});
