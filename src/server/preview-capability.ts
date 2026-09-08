import { jwtVerify, SignJWT } from "jose";

export const previewCapabilityAudience = "agent-online:project-preview" as const;

export type PreviewCapabilityClaims = {
  aud: typeof previewCapabilityAudience;
  exp: number;
  iat: number;
  previewSessionId: string;
  projectId: string;
  scope: "preview:read";
  v: 1;
};

export type PreviewCapabilityCodecOptions = {
  now?: () => Date;
  secret: string;
};

export function previewContentBasePath(projectId: string, token: string) {
  return (
    `/api/projects/${encodeURIComponent(projectId)}` +
    `/preview/content/${encodeURIComponent(token)}/`
  );
}

const encoder = new TextEncoder();
const maximumCapabilityLifetimeSeconds = 30 * 60;
const maximumTokenLength = 2_048;
const futureClockSkewSeconds = 30;

export function createPreviewCapabilityCodec(options: PreviewCapabilityCodecOptions) {
  if (options.secret.length < 32) {
    throw new Error("Preview capability signing requires a secret with at least 32 characters");
  }

  const signingKey = deriveSigningKey(options.secret);
  const now = options.now ?? (() => new Date());

  return {
    async issue(input: {
      expiresAt: Date;
      issuedAt: Date;
      previewSessionId: string;
      projectId: string;
    }) {
      const claims = createClaims(input);
      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .sign(await signingKey);
      if (token.length > maximumTokenLength) {
        throw new Error("Capability exceeds maximum token length");
      }
      return token;
    },

    async verify(token: string): Promise<PreviewCapabilityClaims | null> {
      if (!token || token.length > maximumTokenLength) {
        return null;
      }
      try {
        const currentDate = now();
        const { payload } = await jwtVerify(token, await signingKey, {
          algorithms: ["HS256"],
          audience: previewCapabilityAudience,
          currentDate,
          requiredClaims: ["iat", "exp"],
          typ: "JWT",
        });
        // iat skew is independent of expiry: no grace period for expired capabilities.
        return isValidClaims(payload, Math.floor(currentDate.getTime() / 1_000)) ? payload : null;
      } catch {
        return null;
      }
    },
  };
}

function createClaims(input: {
  expiresAt: Date;
  issuedAt: Date;
  previewSessionId: string;
  projectId: string;
}): PreviewCapabilityClaims {
  const iat = toEpochSeconds(input.issuedAt);
  const exp = toEpochSeconds(input.expiresAt);
  if (!isNonEmptyString(input.projectId) || !isNonEmptyString(input.previewSessionId)) {
    throw new Error("Preview capability identifiers must not be empty");
  }
  if (exp <= iat || exp - iat > maximumCapabilityLifetimeSeconds) {
    throw new Error(
      `Preview capability lifetime must be between 1 and ${maximumCapabilityLifetimeSeconds} seconds`,
    );
  }

  return {
    aud: previewCapabilityAudience,
    exp,
    iat,
    previewSessionId: input.previewSessionId,
    projectId: input.projectId,
    scope: "preview:read",
    v: 1,
  };
}

function isValidClaims(value: unknown, now: number): value is PreviewCapabilityClaims {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.v === 1 &&
    value.aud === previewCapabilityAudience &&
    value.scope === "preview:read" &&
    isNonEmptyString(value.projectId) &&
    isNonEmptyString(value.previewSessionId) &&
    isSafeInteger(value.iat) &&
    isSafeInteger(value.exp) &&
    value.exp > value.iat &&
    value.exp - value.iat <= maximumCapabilityLifetimeSeconds &&
    value.iat <= now + futureClockSkewSeconds &&
    value.exp > now
  );
}

async function deriveSigningKey(secret: string) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);

  return crypto.subtle.deriveKey(
    {
      hash: "SHA-256",
      info: encoder.encode("project-preview-capability-signing"),
      name: "HKDF",
      salt: encoder.encode("agent-online/preview-capability/v1"),
    },
    material,
    {
      hash: "SHA-256",
      length: 256,
      name: "HMAC",
    },
    false,
    ["sign", "verify"],
  );
}

function toEpochSeconds(value: Date) {
  const timestamp = value.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error("Preview capability timestamps must be valid dates");
  }
  return Math.floor(timestamp / 1_000);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 100;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
