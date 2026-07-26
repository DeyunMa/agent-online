import type {
  AgentEvent,
  AgentExecution,
  AgentRunInput,
  AgentRuntime,
} from "./contract";
import type { SandboxProcessEvent, SandboxProcessSession } from "../runtime/contract";

const modelProviderId = "agent-online";
const piConfigDirectory = "/tmp";
const piModelsPath = `${piConfigDirectory}/models.json`;

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
    const modelConfiguration = input.modelAccess ? createModelConfiguration(input.modelAccess) : null;
    if (modelConfiguration) {
      await context.files.write(piModelsPath, JSON.stringify(modelConfiguration));
    }

    const session = await context.processes.start({
      agentRunId: input.agentRunId,
      args: createPiArguments(input),
      command: "pi",
      cwd: input.workingDirectory,
      env: input.modelAccess
        ? {
            AGENT_ONLINE_GATEWAY_TOKEN: input.modelAccess.bearerToken,
            PI_CODING_AGENT_DIR: piConfigDirectory,
          }
        : undefined,
    });

    await session.write(`${JSON.stringify({
      id: input.agentRunId,
      message: input.prompt,
      type: "prompt",
    })}\n`);

    return new PiAgentExecution(session, input);
  },
};

class PiAgentExecution implements AgentExecution {
  constructor(
    private readonly session: SandboxProcessSession,
    private readonly input: AgentRunInput,
  ) {}

  get providerProcessRef() {
    return this.session.providerProcessRef;
  }

  async cancel(reason: "completed" | "cancelled" | "timed_out" | "failed") {
    if (reason !== "completed") {
      try {
        await this.session.write(`${JSON.stringify({ type: "abort" })}\n`);
      } catch {
        // Process termination remains the fail-closed cancellation path.
      }
    }

    await this.session.terminate(reason);
  }

  async *events(): AsyncIterable<AgentEvent> {
    yield {
      agentRuntimeId: "pi",
      agentRunId: this.input.agentRunId,
      sandboxLeaseId: this.input.sandboxLeaseId,
      type: "agent.started",
    };

    let stdoutBuffer = "";
    let finalText = "";

    for await (const processEvent of this.session.events()) {
      if (processEvent.type === "process.output" && processEvent.stream === "stdout") {
        stdoutBuffer += processEvent.chunk;
        const parsed = readJsonLines(stdoutBuffer);
        stdoutBuffer = parsed.remainder;

        for (const record of parsed.records) {
          const event = parsePiRecord(record);

          if (event.type === "text") {
            finalText += event.chunk;
            yield {
              agentRuntimeId: "pi",
              agentRunId: this.input.agentRunId,
              chunk: event.chunk,
              sandboxLeaseId: this.input.sandboxLeaseId,
              type: "agent.output",
            };
          }

          if (event.type === "tool") {
            yield {
              agentRuntimeId: "pi",
              agentRunId: this.input.agentRunId,
              sandboxLeaseId: this.input.sandboxLeaseId,
              tool: event.tool,
              type: "agent.tool.started",
            };
          }

          if (event.type === "settled") {
            await this.cancel("completed");
            yield completedEvent(this.input, 0, finalText);
            return;
          }
        }
      }

      if (processEvent.type === "process.completed") {
        if (stdoutBuffer.trim()) {
          for (const record of readJsonLines(`${stdoutBuffer}\n`).records) {
            const event = parsePiRecord(record);
            if (event.type === "text") {
              finalText += event.chunk;
              yield {
                agentRuntimeId: "pi",
                agentRunId: this.input.agentRunId,
                chunk: event.chunk,
                sandboxLeaseId: this.input.sandboxLeaseId,
                type: "agent.output",
              };
            }
          }
        }

        yield completedEvent(
          this.input,
          processEvent.exitCode === 0 ? 1 : processEvent.exitCode,
          finalText,
        );
        return;
      }
    }

    throw new Error("Pi RPC process ended without agent_settled or process completion");
  }
}

type ParsedPiEvent =
  | { chunk: string; type: "text" }
  | { tool: string; type: "tool" }
  | { type: "settled" }
  | { type: "ignored" };

function parsePiRecord(record: unknown): ParsedPiEvent {
  if (!isRecord(record) || typeof record.type !== "string") {
    throw new Error("Pi RPC emitted an invalid JSONL record");
  }

  if (record.type === "response" && record.success === false) {
    throw new Error("Pi RPC rejected the Agent command");
  }

  if (record.type === "message_update" && isRecord(record.assistantMessageEvent)) {
    const update = record.assistantMessageEvent;
    if (update.type === "text_delta" && typeof update.delta === "string") {
      return { chunk: update.delta, type: "text" };
    }
  }

  if (record.type === "tool_execution_start" && typeof record.toolName === "string") {
    return { tool: record.toolName, type: "tool" };
  }

  if (record.type === "agent_settled") {
    return { type: "settled" };
  }

  return { type: "ignored" };
}

function readJsonLines(input: string) {
  const records: unknown[] = [];
  let offset = 0;

  while (true) {
    const newlineIndex = input.indexOf("\n", offset);
    if (newlineIndex === -1) {
      return { records, remainder: input.slice(offset) };
    }

    const rawLine = input.slice(offset, newlineIndex);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    offset = newlineIndex + 1;
    if (!line) {
      continue;
    }

    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error("Pi RPC emitted malformed JSONL");
    }
  }
}

function createPiArguments(input: AgentRunInput) {
  const args = ["--mode", "rpc", "--no-session"];
  if (input.modelAccess) {
    args.push("--provider", modelProviderId, "--model", input.modelAccess.modelId);
  }

  return args;
}

function createModelConfiguration(modelAccess: NonNullable<AgentRunInput["modelAccess"]>) {
  const baseUrl = new URL(modelAccess.baseUrl);
  if (baseUrl.protocol !== "https:" && baseUrl.hostname !== "localhost" && baseUrl.hostname !== "127.0.0.1") {
    throw new Error("Pi ModelGateway baseUrl must use HTTPS outside local development");
  }

  if (
    !Number.isSafeInteger(modelAccess.maxOutputTokens) ||
    modelAccess.maxOutputTokens < 1 ||
    modelAccess.maxOutputTokens > 65_536
  ) {
    throw new Error("Pi maxOutputTokens is outside the supported range");
  }

  return {
    providers: {
      [modelProviderId]: {
        api: "openai-completions",
        apiKey: "$AGENT_ONLINE_GATEWAY_TOKEN",
        authHeader: true,
        baseUrl: baseUrl.toString().replace(/\/$/, ""),
        compat: {
          maxTokensField: "max_tokens",
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsStore: false,
          supportsUsageInStreaming: true,
        },
        models: [
          {
            contextWindow: 128_000,
            id: modelAccess.modelId,
            input: ["text"],
            maxTokens: modelAccess.maxOutputTokens,
            name: "Agent Online Gemini",
            reasoning: false,
          },
        ],
      },
    },
  };
}

function completedEvent(input: AgentRunInput, exitCode: number, finalText: string): AgentEvent {
  return {
    agentRuntimeId: "pi",
    agentRunId: input.agentRunId,
    exitCode,
    finalText: finalText || null,
    sandboxLeaseId: input.sandboxLeaseId,
    type: "agent.completed",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
