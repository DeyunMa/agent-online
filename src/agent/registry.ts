import type { AgentRuntime, AgentRuntimeId } from "./contract";
import { piRuntime } from "./pi-runtime";

export const defaultAgentRuntimeId = "pi" as const;

const installedAgentRuntimes: ReadonlyMap<AgentRuntimeId, AgentRuntime> = new Map([[piRuntime.id, piRuntime]]);

export function getAgentRuntime(id: AgentRuntimeId): AgentRuntime {
  const runtime = installedAgentRuntimes.get(id);

  if (!runtime) {
    throw new Error(`Agent runtime is not installed: ${id}`);
  }

  return runtime;
}
