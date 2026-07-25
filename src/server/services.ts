import { getAgentRuntime } from "../agent/registry";
import type {
  AgentRunRepository,
  MessageRepository,
  ProjectRepository,
  SandboxLeaseRepository,
} from "../application/ports";
import { RunCoordinator } from "../application/run-coordinator";
import type { RuntimeKind, SandboxRuntime } from "../runtime/contract";
import { FakeSandboxRuntime } from "../runtime/fake-runtime";
import type { AppBindings } from "./env";
import {
  D1AgentRunRepository,
  D1MessageRepository,
  D1ProjectRepository,
  D1SandboxLeaseRepository,
} from "./persistence/d1-repositories";

export type ServerServices = {
  agentRuns: AgentRunRepository;
  messages: MessageRepository;
  projects: ProjectRepository;
  runCoordinator: Pick<RunCoordinator, "start">;
  sandboxLeases: SandboxLeaseRepository;
};

export const installedSandboxRuntimeId = "fake" as const;

const sandboxRuntimes: ReadonlyMap<RuntimeKind, SandboxRuntime> = new Map([
  [installedSandboxRuntimeId, new FakeSandboxRuntime({ completionDelayMs: 8_000 })],
]);

export function createServerServices(env: AppBindings): ServerServices {
  const agentRuns = new D1AgentRunRepository(env.DB);
  const sandboxLeases = new D1SandboxLeaseRepository(env.DB);

  return {
    agentRuns,
    messages: new D1MessageRepository(env.DB),
    projects: new D1ProjectRepository(env.DB),
    runCoordinator: new RunCoordinator({
      agentRunRepository: agentRuns,
      clock: { now: () => new Date() },
      getAgentRuntime,
      getSandboxRuntime,
      sandboxLeaseRepository: sandboxLeases,
    }),
    sandboxLeases,
  };
}

function getSandboxRuntime(id: RuntimeKind): SandboxRuntime {
  const runtime = sandboxRuntimes.get(id);

  if (!runtime) {
    throw new Error(`Sandbox runtime is not installed: ${id}`);
  }

  return runtime;
}
