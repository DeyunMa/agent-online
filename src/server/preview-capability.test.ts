import { describe, expect, it } from "vitest";

import { createPreviewCapabilityCodec, previewCapabilityAudience } from "./preview-capability";

const secret = "test-secret-with-at-least-thirty-two-characters";
const issuedAt = new Date("2026-07-26T00:00:00.000Z");
const expiresAt = new Date("2026-07-26T00:30:00.000Z");

describe("Preview capability codec", () => {
  it("binds a short-lived token to one Project and Preview session", async () => {
    const codec = createPreviewCapabilityCodec({
      now: () => new Date("2026-07-26T00:01:00.000Z"),
      secret,
    });
    const token = await codec.issue({
      expiresAt,
      issuedAt,
      previewSessionId: "preview-1",
      projectId: "project-1",
    });

    await expect(codec.verify(token)).resolves.toEqual({
      aud: previewCapabilityAudience,
      exp: 1_785_025_800,
      iat: 1_785_024_000,
      previewSessionId: "preview-1",
      projectId: "project-1",
      scope: "preview:read",
      v: 1,
    });
  });

  it("rejects expired, tampered, excessive, and weak capabilities", async () => {
    const issuer = createPreviewCapabilityCodec({
      now: () => issuedAt,
      secret,
    });
    const token = await issuer.issue({
      expiresAt,
      issuedAt,
      previewSessionId: "preview-1",
      projectId: "project-1",
    });
    const [payload, signature] = token.split(".");

    await expect(
      createPreviewCapabilityCodec({
        now: () => expiresAt,
        secret,
      }).verify(token),
    ).resolves.toBeNull();
    await expect(issuer.verify(`${payload}x.${signature}`)).resolves.toBeNull();
    expect(() => createPreviewCapabilityCodec({ secret: "too-short" })).toThrow(
      "at least 32 characters",
    );
    await expect(
      issuer.issue({
        expiresAt: new Date("2026-07-26T00:31:00.000Z"),
        issuedAt,
        previewSessionId: "preview-1",
        projectId: "project-1",
      }),
    ).rejects.toThrow("lifetime");
  });
});
