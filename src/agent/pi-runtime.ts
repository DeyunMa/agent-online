import type { AgentRuntime } from "./contract";

export const piRuntime: AgentRuntime = {
  capabilities: {
    interactiveTerminal: false,
    resumableSession: true,
    structuredEvents: true,
  },
  id: "pi",

  async *start(context, input) {
    yield {
      agentRuntimeId: this.id,
      runId: input.runId,
      sandboxLeaseId: input.sandboxLeaseId,
      type: "agent.started",
    };

    for await (const event of context.sandbox.execute(context.sandboxHandle, {
      args: ["--mode", "rpc"],
      command: "pi",
      cwd: input.workingDirectory,
      runId: input.runId,
    })) {
      if (event.type === "process.output") {
        yield {
          agentRuntimeId: this.id,
          chunk: event.chunk,
          runId: input.runId,
          sandboxLeaseId: input.sandboxLeaseId,
          type: "agent.output",
        };
      }

      if (event.type === "process.completed") {
        yield {
          agentRuntimeId: this.id,
          exitCode: event.exitCode,
          runId: input.runId,
          sandboxLeaseId: input.sandboxLeaseId,
          type: "agent.completed",
        };
      }
    }
  },
};
