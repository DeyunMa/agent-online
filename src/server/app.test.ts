import { describe, expect, it } from "vitest";

import { app } from "./app";
import type { AppBindings } from "./env";
import {
  maximumProductRequestBytes,
  maximumProjectFileUploadRequestBytes,
} from "./http/product-request-guard";

describe("Worker API", () => {
  it("returns a health response", async () => {
    const response = await app.request("http://agent-online.test/api/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ name: "agent-online", status: "ok" });
  });

  it("publishes the safe Run creation capability", async () => {
    const response = await app.request("http://agent-online.test/api/capabilities", undefined, {
      RUNS_ENABLED: "false",
    } as AppBindings);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      agentRuntimeIds: ["pi"],
      changesEnabled: false,
      defaultAgentRuntimeId: "pi",
      fileUploadEnabled: false,
      previewEnabled: false,
      runCreationEnabled: false,
      terminalEnabled: false,
    });
  });

  it("keeps Goose private in spike mode and publishes it only in public E2B mode", async () => {
    const spike = await app.request("http://agent-online.test/api/capabilities", undefined, {
      GOOSE_RUNTIME_MODE: "spike",
      RUNTIME_PROVIDER: "e2b",
    } as AppBindings);
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
      changesEnabled: true,
      fileUploadEnabled: true,
      previewEnabled: true,
      terminalEnabled: true,
    });
    await expect(publicResponse.json()).resolves.toMatchObject({
      agentRuntimeIds: ["pi", "goose"],
    });
  });

  it("adds baseline security headers to API responses", async () => {
    const response = await app.request("https://agent-online.test/api/health");

    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("rejects cross-origin product mutations before authentication", async () => {
    const response = await app.request("https://agent-online.test/api/projects", {
      body: JSON.stringify({ title: "Cross-origin project" }),
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      method: "POST",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "request.forbidden", retryable: false },
    });
  });

  it("rejects oversized product requests before authentication", async () => {
    const response = await app.request("https://agent-online.test/api/projects", {
      body: "x".repeat(maximumProductRequestBytes + 1),
      headers: {
        "content-type": "application/json",
        origin: "https://agent-online.test",
      },
      method: "POST",
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "request.too_large", retryable: false },
    });
  });

  it("allows multipart overhead but rejects uploads above their dedicated request limit", async () => {
    const response = await app.request("https://agent-online.test/api/projects/project-1/files", {
      body: "x".repeat(maximumProjectFileUploadRequestBytes + 1),
      headers: {
        "content-type": "multipart/form-data; boundary=test",
        origin: "https://agent-online.test",
      },
      method: "POST",
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "request.too_large", retryable: false },
    });
  });
});
