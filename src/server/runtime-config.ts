import type { RuntimeKind } from "../runtime/contract";
import { modelGatewayEndpointPath } from "./model-gateway-service";
import type { AppBindings } from "./env";

export const defaultPlatformModelId = "gemini-3.6-flash";
export const defaultWorkingDirectory = "/workspace";
export const defaultModelMaxOutputTokens = 4_096;

export type InstalledSandboxRuntimeId = Extract<RuntimeKind, "e2b" | "fake">;

export type E2BExecutionConfig = {
  apiKey: string;
  idleTtlMs: number;
  modelGatewayBaseUrl: string;
  modelMaxOutputTokens: number;
  runTimeoutMs: number;
  templateId: string;
  workingDirectory: string;
};

const defaultIdleTtlSeconds = 600;
const defaultRunWallSeconds = 1_800;
const maximumRunWallSeconds = 3_600;
const maximumIdleTtlSeconds = 86_400;

export function getInstalledSandboxRuntimeId(env: AppBindings): InstalledSandboxRuntimeId {
  const value = env.RUNTIME_PROVIDER?.trim() || "fake";
  if (value !== "fake" && value !== "e2b") {
    throw new Error("RUNTIME_PROVIDER must be fake or e2b");
  }

  return value;
}

export function getDefaultModelId(env: AppBindings) {
  const modelId = env.DEFAULT_MODEL_ID?.trim() || defaultPlatformModelId;
  if (!modelId || modelId.length > 200 || !/^[A-Za-z0-9._:/-]+$/.test(modelId)) {
    throw new Error("DEFAULT_MODEL_ID is invalid");
  }

  return modelId;
}

export function getE2BExecutionConfig(env: AppBindings): E2BExecutionConfig {
  if (!env.E2B_API_KEY || !env.E2B_TEMPLATE_ID || !env.BETTER_AUTH_SECRET) {
    throw new Error(
      "E2B runtime is not configured. Set E2B_API_KEY, E2B_TEMPLATE_ID, and BETTER_AUTH_SECRET.",
    );
  }

  return {
    apiKey: env.E2B_API_KEY,
    idleTtlMs:
      parsePositiveSeconds(
        env.RUNTIME_IDLE_TTL_SECONDS,
        defaultIdleTtlSeconds,
        maximumIdleTtlSeconds,
        "RUNTIME_IDLE_TTL_SECONDS",
      ) * 1_000,
    modelGatewayBaseUrl: resolveModelGatewayBaseUrl(env),
    modelMaxOutputTokens: defaultModelMaxOutputTokens,
    runTimeoutMs:
      parsePositiveSeconds(
        env.MAX_RUN_WALL_SECONDS,
        defaultRunWallSeconds,
        maximumRunWallSeconds,
        "MAX_RUN_WALL_SECONDS",
      ) * 1_000,
    templateId: env.E2B_TEMPLATE_ID,
    workingDirectory: defaultWorkingDirectory,
  };
}

function resolveModelGatewayBaseUrl(env: AppBindings) {
  const source = env.MODEL_GATEWAY_BASE_URL?.trim() || env.BETTER_AUTH_URL?.trim();
  if (!source) {
    throw new Error("Set BETTER_AUTH_URL or MODEL_GATEWAY_BASE_URL for the E2B ModelGateway.");
  }

  const url = new URL(source);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
  ) {
    throw new Error("ModelGateway must use HTTPS outside local development");
  }

  url.pathname = modelGatewayEndpointPath.replace(/\/chat\/completions$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function parsePositiveSeconds(
  rawValue: string | undefined,
  defaultValue: number,
  maximumValue: number,
  name: string,
) {
  const value = rawValue === undefined || rawValue.trim() === "" ? defaultValue : Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximumValue) {
    throw new Error(`${name} must be an integer between 1 and ${maximumValue}`);
  }

  return value;
}
