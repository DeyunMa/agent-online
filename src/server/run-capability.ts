export const modelGatewayCapabilityAudience = "agent-online:model-gateway" as const;

export type RunCapabilityClaims = {
  aud: typeof modelGatewayCapabilityAudience;
  exp: number;
  iat: number;
  maxOutputTokens: number;
  modelId: string;
  projectId: string;
  runId: string;
  scope: "model:complete";
  v: 1;
};

export type IssueRunCapabilityInput = {
  expiresAt: Date;
  issuedAt: Date;
  maxOutputTokens: number;
  modelId: string;
  projectId: string;
  runId: string;
};

export type RunCapabilityCodecOptions = {
  now?: () => Date;
  secret: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const capabilityVersion = 1;
const capabilityScope = "model:complete";
const maximumCapabilityLifetimeSeconds = 3_600;
const maximumOutputTokens = 65_536;
const maximumTokenLength = 4_096;
const futureClockSkewSeconds = 30;

export function createRunCapabilityCodec(options: RunCapabilityCodecOptions) {
  if (options.secret.length < 32) {
    throw new Error("Run capability signing requires a secret with at least 32 characters");
  }

  const signingKey = deriveSigningKey(options.secret);
  const now = options.now ?? (() => new Date());

  return {
    async issue(input: IssueRunCapabilityInput) {
      const claims = createClaims(input);
      const payload = encodeBase64Url(encoder.encode(JSON.stringify(claims)));
      const signature = await crypto.subtle.sign("HMAC", await signingKey, encoder.encode(payload));

      return `${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
    },

    async verify(token: string): Promise<RunCapabilityClaims | null> {
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

function createClaims(input: IssueRunCapabilityInput): RunCapabilityClaims {
  const iat = toEpochSeconds(input.issuedAt);
  const exp = toEpochSeconds(input.expiresAt);

  if (!input.projectId || !input.runId || !input.modelId) {
    throw new Error("Run capability identifiers must not be empty");
  }

  if (
    !Number.isSafeInteger(input.maxOutputTokens) ||
    input.maxOutputTokens < 1 ||
    input.maxOutputTokens > maximumOutputTokens
  ) {
    throw new Error(`Run capability maxOutputTokens must be between 1 and ${maximumOutputTokens}`);
  }

  if (exp <= iat || exp - iat > maximumCapabilityLifetimeSeconds) {
    throw new Error(
      `Run capability lifetime must be between 1 and ${maximumCapabilityLifetimeSeconds} seconds`,
    );
  }

  return {
    aud: modelGatewayCapabilityAudience,
    exp,
    iat,
    maxOutputTokens: input.maxOutputTokens,
    modelId: input.modelId,
    projectId: input.projectId,
    runId: input.runId,
    scope: capabilityScope,
    v: capabilityVersion,
  };
}

function isValidClaims(value: unknown, now: number): value is RunCapabilityClaims {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.v === capabilityVersion &&
    value.aud === modelGatewayCapabilityAudience &&
    value.scope === capabilityScope &&
    isNonEmptyString(value.projectId) &&
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.modelId) &&
    isSafeInteger(value.iat) &&
    isSafeInteger(value.exp) &&
    isSafeInteger(value.maxOutputTokens) &&
    value.maxOutputTokens >= 1 &&
    value.maxOutputTokens <= maximumOutputTokens &&
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
      info: encoder.encode("model-gateway-capability-signing"),
      name: "HKDF",
      salt: encoder.encode("agent-online/run-capability/v1"),
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
    throw new Error("Run capability timestamps must be valid dates");
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
  return typeof value === "string" && value.length > 0;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
