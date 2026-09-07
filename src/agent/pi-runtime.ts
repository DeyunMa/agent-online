import type { AgentEvent, AgentExecution, AgentRunInput, AgentRuntime } from "./contract";
import type { SandboxProcessSession } from "../runtime/contract";

import { AgentJsonLines, assertFinalTextLimit } from "./json-lines";

const modelProviderId = "agent-online";
const piConfigRoot = "/tmp/agent-online-pi";

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
    const piConfigDirectory = getPiConfigDirectory(input.agentRunId);
    const modelConfiguration = input.modelAccess
      ? createModelConfiguration(input.modelAccess)
      : null;
    if (modelConfiguration) {
      await context.files.write(
        `${piConfigDirectory}/models.json`,
        JSON.stringify(modelConfiguration),
      );
    }

    const session = await context.processes.start({
      agentRunId: input.agentRunId,
      args: createPiArguments(input),
      command: "pi",
      cwd: input.workingDirectory,
      ...(input.modelAccess
        ? {
            env: {
              AGENT_ONLINE_GATEWAY_TOKEN: input.modelAccess.bearerToken,
              PI_CODING_AGENT_DIR: piConfigDirectory,
            },
          }
        : {}),
    });

    await session.write(
      `${JSON.stringify({
        id: input.agentRunId,
        message: input.prompt,
        type: "prompt",
      })}\n`,
    );

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

    const lines = new AgentJsonLines();
    let finalText = "";
    let successfulMessage = false;

    try {
      for await (const processEvent of this.session.events()) {
        const records =
          processEvent.type === "process.output" && processEvent.stream === "stdout"
            ? lines.read(processEvent.chunk)
            : processEvent.type === "process.completed"
              ? lines.finish()
              : [];
        for (const record of records) {
          const event = parsePiRecord(record);
          if (event.type === "text") {
            yield {
              agentRuntimeId: "pi",
              agentRunId: this.input.agentRunId,
              chunk: event.chunk,
              sandboxLeaseId: this.input.sandboxLeaseId,
              type: "agent.output",
            };
          }
          if (event.type === "message") {
            finalText = event.text;
            successfulMessage = event.successful;
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
            if (!successfulMessage)
              throw new Error("Pi settled without a successful final assistant message");
            await this.cancel("completed");
            yield completedEvent(this.input, 0, finalText);
            return;
          }
        }
        if (processEvent.type === "process.completed") {
          yield completedEvent(
            this.input,
            processEvent.exitCode === 0 ? 1 : processEvent.exitCode,
            "",
          );
          return;
        }
      }
      throw new Error("Pi RPC process ended without agent_settled or process completion");
    } catch (error) {
      // Do not wait on RPC stdin after a broken/oversized protocol stream.
      await this.session.terminate("failed");
      throw error;
    }
  }
}

type ParsedPiEvent =
  | { chunk: string; type: "text" }
  | { text: string; successful: boolean; type: "message" }
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

  if (
    record.type === "message_start" &&
    isRecord(record.message) &&
    record.message.role === "assistant"
  ) {
    return { text: "", successful: false, type: "message" };
  }

  // Pi 0.82.0 RPC message_end carries the complete AgentMessage. Deltas are
  // progress only; tool turns and failed retry attempts must not become replies.
  if (
    record.type === "message_end" &&
    isRecord(record.message) &&
    record.message.role === "assistant"
  ) {
    const message = record.message;
    if (!Array.isArray(message.content)) throw new Error("Pi emitted invalid assistant content");
    let text = "";
    for (const content of message.content) {
      if (!isRecord(content)) throw new Error("Pi emitted invalid assistant content");
      if (content.type === "text") {
        if (typeof content.text !== "string") throw new Error("Pi emitted invalid assistant text");
        text += content.text;
        assertFinalTextLimit(text);
      }
    }
    return {
      text,
      successful: message.stopReason === "stop" || message.stopReason === "length",
      type: "message",
    };
  }

  if (record.type === "tool_execution_start" && typeof record.toolName === "string") {
    return { tool: record.toolName, type: "tool" };
  }

  if (record.type === "agent_settled") {
    return { type: "settled" };
  }

  return { type: "ignored" };
}

function createPiArguments(input: AgentRunInput) {
  const args = ["--mode", "rpc", "--no-session"];
  if (input.modelAccess) {
    args.push("--provider", modelProviderId, "--model", input.modelAccess.modelId);
  }

  return args;
}

function getPiConfigDirectory(agentRunId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(agentRunId)) {
    throw new Error("AgentRun ID is not safe for a Pi config path");
  }

  return `${piConfigRoot}/${agentRunId}`;
}

function createModelConfiguration(modelAccess: NonNullable<AgentRunInput["modelAccess"]>) {
  const baseUrl = new URL(modelAccess.baseUrl);
  if (
    baseUrl.protocol !== "https:" &&
    baseUrl.hostname !== "localhost" &&
    baseUrl.hostname !== "127.0.0.1"
  ) {
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
