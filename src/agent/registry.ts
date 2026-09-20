import type { AgentRuntime } from "./contract";
import { piRuntime } from "./pi-runtime";

export const defaultAgentRuntimeId = "pi" as const;
export const installedAgentRuntimeIds = [defaultAgentRuntimeId] as const;

const installedAgentRuntimes: ReadonlyMap<string, AgentRuntime> = new Map([
  [piRuntime.id, piRuntime],
]);

export function getAgentRuntime(id: string): AgentRuntime {
  const runtime = installedAgentRuntimes.get(id);

  if (!runtime) {
    throw new Error(`Agent runtime is not installed: ${id}`);
  }

  return runtime;
}
