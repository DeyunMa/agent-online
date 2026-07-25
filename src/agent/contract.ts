import type { RuntimeHandle, SandboxRuntime } from "../runtime/contract";

export type AgentRuntimeId = "pi" | "goose" | "claude-code" | "codex-cli";

export type AgentRuntimeCapabilities = {
  interactiveTerminal: boolean;
  resumableSession: boolean;
  structuredEvents: boolean;
};

export type AgentRunInput = {
  projectId: string;
  runId: string;
  sandboxLeaseId: string;
  workingDirectory: string;
};

export type AgentEvent =
  | { agentRuntimeId: AgentRuntimeId; runId: string; sandboxLeaseId: string; type: "agent.started" }
  | { agentRuntimeId: AgentRuntimeId; chunk: string; runId: string; sandboxLeaseId: string; type: "agent.output" }
  | { agentRuntimeId: AgentRuntimeId; runId: string; sandboxLeaseId: string; tool: string; type: "agent.tool.started" }
  | { agentRuntimeId: AgentRuntimeId; exitCode: number; runId: string; sandboxLeaseId: string; type: "agent.completed" };

export type AgentExecutionContext = {
  sandbox: SandboxRuntime;
  sandboxHandle: RuntimeHandle;
};

export interface AgentRuntime {
  readonly capabilities: AgentRuntimeCapabilities;
  readonly id: AgentRuntimeId;
  start(context: AgentExecutionContext, input: AgentRunInput): AsyncIterable<AgentEvent>;
}
