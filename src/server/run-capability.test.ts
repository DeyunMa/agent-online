import { describe, expect, it } from "vitest";

import { createRunCapabilityCodec, modelGatewayCapabilityAudience } from "./run-capability";

const secret = "test-secret-with-at-least-thirty-two-characters";
const issuedAt = new Date("2026-07-26T00:00:00.000Z");
const expiresAt = new Date("2026-07-26T00:05:00.000Z");

describe("Run capability codec", () => {
  it("issues and verifies a short-lived capability bound to one Run and model", async () => {
    const codec = createRunCapabilityCodec({
      now: () => new Date("2026-07-26T00:01:00.000Z"),
      secret,
    });
    const token = await codec.issue({
      expiresAt,
      issuedAt,
      maxOutputTokens: 512,
      modelId: "gemini-2.5-flash",
      projectId: "project-1",
      runId: "run-1",
    });

    await expect(codec.verify(token)).resolves.toEqual({
      aud: modelGatewayCapabilityAudience,
      exp: 1_785_024_300,
      iat: 1_785_024_000,
      maxOutputTokens: 512,
      modelId: "gemini-2.5-flash",
      projectId: "project-1",
      runId: "run-1",
      scope: "model:complete",
      v: 1,
    });
  });

  it("rejects expired and tampered capabilities", async () => {
    const issuer = createRunCapabilityCodec({
      now: () => issuedAt,
      secret,
    });
    const token = await issuer.issue({
      expiresAt,
      issuedAt,
      maxOutputTokens: 512,
      modelId: "gemini-2.5-flash",
      projectId: "project-1",
      runId: "run-1",
    });
    const expiredVerifier = createRunCapabilityCodec({
      now: () => expiresAt,
      secret,
    });
    const [payload, signature] = token.split(".");

    await expect(expiredVerifier.verify(token)).resolves.toBeNull();
    await expect(issuer.verify(`${payload}x.${signature}`)).resolves.toBeNull();
    await expect(issuer.verify("not-a-capability")).resolves.toBeNull();
  });

  it("rejects excessive capability lifetimes and weak signing secrets", async () => {
    expect(() => createRunCapabilityCodec({ secret: "too-short" })).toThrow("at least 32 characters");

    const codec = createRunCapabilityCodec({ secret });
    await expect(
      codec.issue({
        expiresAt: new Date("2026-07-26T02:00:00.000Z"),
        issuedAt,
        maxOutputTokens: 512,
        modelId: "gemini-2.5-flash",
        projectId: "project-1",
        runId: "run-1",
      }),
    ).rejects.toThrow("lifetime");
  });
});
