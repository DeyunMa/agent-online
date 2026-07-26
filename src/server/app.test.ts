import { describe, expect, it } from "vitest";

import { app } from "./app";
import type { AppBindings } from "./env";

describe("Worker API", () => {
  it("returns a health response", async () => {
    const response = await app.request("http://agent-online.test/api/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ name: "agent-online", status: "ok" });
  });

  it("publishes the safe Run creation capability", async () => {
    const response = await app.request(
      "http://agent-online.test/api/capabilities",
      undefined,
      { RUNS_ENABLED: "false" } as AppBindings,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      agentRuntimeIds: ["pi"],
      defaultAgentRuntimeId: "pi",
      runCreationEnabled: false,
      terminalEnabled: false,
    });
  });

  it("keeps Goose private in spike mode and publishes it only in public E2B mode", async () => {
    const spike = await app.request(
      "http://agent-online.test/api/capabilities",
      undefined,
      {
        GOOSE_RUNTIME_MODE: "spike",
        RUNTIME_PROVIDER: "e2b",
      } as AppBindings,
    );
    const publicResponse = await app.request(
      "http://agent-online.test/api/capabilities",
      undefined,
      {
        GOOSE_RUNTIME_MODE: "public",
        RUNTIME_PROVIDER: "e2b",
      } as AppBindings,
    );

    await expect(spike.json()).resolves.toMatchObject({
      agentRuntimeIds: ["pi"],
      terminalEnabled: true,
    });
    await expect(publicResponse.json()).resolves.toMatchObject({
      agentRuntimeIds: ["pi", "goose"],
    });
  });
});
