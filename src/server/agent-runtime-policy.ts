import type {
  AgentRuntime,
  AgentRuntimeId,
} from "../agent/contract";
import {
  defaultAgentRuntimeId,
  getAgentRuntime,
} from "../agent/registry";
import type { InstalledSandboxRuntimeId } from "./runtime-config";
import type { AppBindings } from "./env";

export type GooseRuntimeMode = "disabled" | "public" | "spike";

export type AgentRuntimePolicy = {
  executionRuntimeIds: readonly AgentRuntimeId[];
  publicRuntimeIds: readonly AgentRuntimeId[];
  resolve(id: AgentRuntimeId): AgentRuntime;
};

export function getAgentRuntimePolicy(
  env: AppBindings,
  sandboxRuntimeId: InstalledSandboxRuntimeId,
): AgentRuntimePolicy {
  const gooseMode = getGooseRuntimeMode(env);
  const gooseExecutable =
    sandboxRuntimeId === "e2b" && gooseMode !== "disabled";
  const executionRuntimeIds: readonly AgentRuntimeId[] = gooseExecutable
    ? [defaultAgentRuntimeId, "goose"]
    : [defaultAgentRuntimeId];
  const publicRuntimeIds: readonly AgentRuntimeId[] =
    gooseExecutable && gooseMode === "public"
      ? [defaultAgentRuntimeId, "goose"]
      : [defaultAgentRuntimeId];

  return {
    executionRuntimeIds,
    publicRuntimeIds,
    resolve(id) {
      if (!executionRuntimeIds.includes(id)) {
        throw new Error(`Agent runtime is not enabled: ${id}`);
      }
      return getAgentRuntime(id);
    },
  };
}

export function getGooseRuntimeMode(env: AppBindings): GooseRuntimeMode {
  const value = env.GOOSE_RUNTIME_MODE?.trim().toLowerCase() || "disabled";
  if (value !== "disabled" && value !== "spike" && value !== "public") {
    throw new Error(
      "GOOSE_RUNTIME_MODE must be disabled, spike, or public",
    );
  }
  return value;
}
