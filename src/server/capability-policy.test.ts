import { decodeJwt, decodeProtectedHeader, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { createPreviewCapabilityCodec } from "./preview-capability";
import { createRunCapabilityCodec } from "./run-capability";

const secret = "test-secret-with-at-least-thirty-two-characters";
const iat = 1_785_024_000;
const now = () => new Date(iat * 1_000);

for (const kind of ["run", "preview"] as const) {
  describe(`${kind} JWT policy`, () => {
    const codec =
      kind === "run"
        ? createRunCapabilityCodec({ now, secret })
        : createPreviewCapabilityCodec({ now, secret });
    const claims = {
      aud: kind === "run" ? "agent-online:model-gateway" : "agent-online:project-preview",
      exp: iat + 300,
      iat,
      maxOutputTokens: 512,
      modelId: "gemini-2.5-flash",
      previewSessionId: "preview-1",
      projectId: "project-1",
      runId: "run-1",
      scope: kind === "run" ? "model:complete" : "preview:read",
      v: 1,
    };

    // Independent test signer creates valid signatures over deliberately invalid policies.
    async function sign(overrides: Record<string, unknown> = {}, alg = "HS256") {
      const encoder = new TextEncoder();
      const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
        "deriveBits",
      ]);
      const key = new Uint8Array(
        await crypto.subtle.deriveBits(
          {
            hash: "SHA-256",
            info: encoder.encode(
              kind === "run"
                ? "model-gateway-capability-signing"
                : "project-preview-capability-signing",
            ),
            name: "HKDF",
            salt: encoder.encode(`agent-online/${kind}-capability/v1`),
          },
          material,
          256,
        ),
      );
      return new SignJWT({ ...claims, ...overrides })
        .setProtectedHeader({ alg, typ: "JWT" })
        .sign(key);
    }

    it("accepts standard JWT and the exact future iat skew boundary", async () => {
      const token = await sign();
      expect(decodeProtectedHeader(token)).toEqual({ alg: "HS256", typ: "JWT" });
      expect(decodeJwt(token).aud).toBe(claims.aud);
      await expect(codec.verify(token)).resolves.toEqual(claims);
      await expect(codec.verify(await sign({ iat: iat + 30 }))).resolves.not.toBeNull();
    });

    it.each([
      ["expired at exact boundary", { exp: iat }],
      ["iat beyond future skew", { iat: iat + 31 }],
      ["excessive lifetime", { exp: iat + (kind === "run" ? 3_601 : 1_801) }],
      ["wrong audience", { aud: "other" }],
      ["audience array", { aud: [claims.aud] }],
      ["wrong scope", { scope: "other" }],
      ["missing iat", { iat: undefined }],
      ["missing exp", { exp: undefined }],
      ["fractional iat", { iat: iat - 0.5 }],
      ["empty project", { projectId: "" }],
      ["wrong version", { v: 2 }],
      ["not yet active", { nbf: iat + 1 }],
    ])("rejects %s with an otherwise valid signature", async (_name, overrides) => {
      await expect(codec.verify(await sign(overrides))).resolves.toBeNull();
    });

    it("rejects other algorithms, long input and legacy two-part tokens", async () => {
      await expect(codec.verify(await sign({}, "HS384"))).resolves.toBeNull();
      await expect(codec.verify("x".repeat(4_097))).resolves.toBeNull();
      const [, payload, signature] = (await sign()).split(".");
      await expect(codec.verify(`${payload}.${signature}`)).resolves.toBeNull();
    });

    it("rejects a valid token signed for the other purpose", async () => {
      const other =
        kind === "run"
          ? createPreviewCapabilityCodec({ now, secret })
          : createRunCapabilityCodec({ now, secret });
      await expect(other.verify(await sign())).resolves.toBeNull();
    });

    if (kind === "run") {
      it.each([
        { modelId: "" },
        { runId: "" },
        { maxOutputTokens: 0 },
        { maxOutputTokens: 65_537 },
        { maxOutputTokens: 1.5 },
      ])("rejects invalid model budget or binding %j", async (overrides) => {
        await expect(codec.verify(await sign(overrides))).resolves.toBeNull();
      });
    } else {
      it("rejects excessive preview identifiers", async () => {
        await expect(
          codec.verify(await sign({ previewSessionId: "x".repeat(101) })),
        ).resolves.toBeNull();
      });
    }
  });
}
