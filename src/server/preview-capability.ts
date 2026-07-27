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
const decoder = new TextDecoder("utf-8", { fatal: true });
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
      const payload = encodeBase64Url(encoder.encode(JSON.stringify(claims)));
      const signature = await crypto.subtle.sign("HMAC", await signingKey, encoder.encode(payload));

      return `${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
    },

    async verify(token: string): Promise<PreviewCapabilityClaims | null> {
      if (!token || token.length > maximumTokenLength) {
        return null;
      }
      const parts = token.split(".");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return null;
      }

      try {
        const verified = await crypto.subtle.verify(
          "HMAC",
          await signingKey,
          decodeBase64Url(parts[1]),
          encoder.encode(parts[0]),
        );
        if (!verified) {
          return null;
        }
        const claims = JSON.parse(decoder.decode(decodeBase64Url(parts[0]))) as unknown;
        return isValidClaims(claims, Math.floor(now().getTime() / 1_000)) ? claims : null;
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

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url value");
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
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
