import type { AgentExecution, AgentRuntime } from "./contract";

export const piRuntime: AgentRuntime = {
  capabilities: {
    modelGateway: true,
    processTermination: true,
    stdin: true,
    streamingOutput: true,
    tty: false,
  },
  id: "pi",

  async start(context, input): Promise<AgentExecution> {
    const session = await context.processes.start({
      agentRunId: input.agentRunId,
      args: ["--mode", "rpc"],
      command: "pi",
      cwd: input.workingDirectory,
    });
    const agentRuntimeId = this.id;

    // P0 only proves input ownership. The real Pi JSON-RPC request shape belongs to the Pi + ModelGateway vertical slice.
    await session.write(input.prompt);

    return {
      cancel: (reason) => session.terminate(reason),
      async *events() {
        yield {
          agentRuntimeId,
          agentRunId: input.agentRunId,
          sandboxLeaseId: input.sandboxLeaseId,
          type: "agent.started",
        };

        for await (const event of session.events()) {
          if (event.type === "process.output") {
            yield {
              agentRuntimeId,
              agentRunId: input.agentRunId,
              chunk: event.chunk,
              sandboxLeaseId: input.sandboxLeaseId,
              type: "agent.output",
            };
          }

          if (event.type === "process.completed") {
            yield {
              agentRuntimeId,
              agentRunId: input.agentRunId,
              exitCode: event.exitCode,
              sandboxLeaseId: input.sandboxLeaseId,
              type: "agent.completed",
            };
          }
        }
      },
    };
  },
};
