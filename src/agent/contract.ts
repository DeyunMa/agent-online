import type { ProcessTerminationReason, SandboxCommand, SandboxProcessSession } from "../runtime/contract";

export type AgentRuntimeId = "pi" | "goose" | "claude-code" | "codex-cli";

export type AgentRuntimeCapabilities = {
  modelGateway: boolean;
  processTermination: boolean;
  stdin: boolean;
  streamingOutput: boolean;
  tty: boolean;
};

export type AgentRunInput = {
  agentRunId: string;
  projectId: string;
  prompt: string;
  sandboxLeaseId: string;
  workingDirectory: string;
};

export type AgentEvent =
  | { agentRuntimeId: AgentRuntimeId; agentRunId: string; sandboxLeaseId: string; type: "agent.started" }
  | { agentRuntimeId: AgentRuntimeId; agentRunId: string; chunk: string; sandboxLeaseId: string; type: "agent.output" }
  | { agentRuntimeId: AgentRuntimeId; agentRunId: string; sandboxLeaseId: string; tool: string; type: "agent.tool.started" }
  | { agentRuntimeId: AgentRuntimeId; agentRunId: string; exitCode: number; sandboxLeaseId: string; type: "agent.completed" };

export interface AgentProcessLauncher {
  start(command: SandboxCommand): Promise<SandboxProcessSession>;
}

export type AgentExecutionContext = {
  processes: AgentProcessLauncher;
};

export interface AgentExecution {
  cancel(reason: ProcessTerminationReason): Promise<void>;
  events(): AsyncIterable<AgentEvent>;
}

export interface AgentRuntime {
  readonly capabilities: AgentRuntimeCapabilities;
  readonly id: AgentRuntimeId;
  start(context: AgentExecutionContext, input: AgentRunInput): Promise<AgentExecution>;
}
