import type { AgentEvent, AgentExecution, AgentRunInput, AgentRuntime } from "./contract";
import type { ProcessTerminationReason, SandboxProcessSession } from "../runtime/contract";

const modelProviderId = "agent_online";
const gooseConfigRoot = "/tmp/agent-online-goose";
const gooseMaxTurns = 25;

export const gooseRuntime: AgentRuntime = {
  capabilities: {
    modelGateway: true,
    processTermination: true,
    stdin: false,
    streamingOutput: true,
    tty: false,
  },
  id: "goose",

  async start(context, input): Promise<AgentExecution> {
    if (!input.modelAccess) {
      throw new Error("Goose requires Run-scoped ModelGateway access");
    }

    const runRoot = getGooseRunRoot(input.agentRunId);
    const promptPath = `${runRoot}/prompt.md`;
    const providerPath = `${runRoot}/config/custom_providers/${modelProviderId}.json`;
    await context.files.write(
      providerPath,
      JSON.stringify(createProviderConfiguration(input.modelAccess)),
    );
    await context.files.write(promptPath, input.prompt);

    const session = await context.processes.start({
      agentRunId: input.agentRunId,
      args: createGooseArguments(input, promptPath),
      command: "goose",
      cwd: input.workingDirectory,
      env: {
        AGENT_ONLINE_GATEWAY_TOKEN: input.modelAccess.bearerToken,
        GOOSE_CONTEXT_STRATEGY: "summarize",
        GOOSE_DISABLE_SESSION_NAMING: "true",
        GOOSE_MAX_TURNS: String(gooseMaxTurns),
        GOOSE_MODE: "auto",
        GOOSE_PATH_ROOT: runRoot,
      },
    });

    return new GooseAgentExecution(session, input);
  },
};

class GooseAgentExecution implements AgentExecution {
  constructor(
    private readonly session: SandboxProcessSession,
    private readonly input: AgentRunInput,
  ) {}

  get providerProcessRef() {
    return this.session.providerProcessRef;
  }

  async cancel(reason: ProcessTerminationReason) {
    if (reason !== "completed") {
      await this.session.terminate(reason);
    }
  }

  async *events(): AsyncIterable<AgentEvent> {
    yield {
      agentRuntimeId: "goose",
      agentRunId: this.input.agentRunId,
      sandboxLeaseId: this.input.sandboxLeaseId,
      type: "agent.started",
    };

    let stdoutBuffer = "";
    let completed = false;
    let finalText = "";

    for await (const processEvent of this.session.events()) {
      if (processEvent.type === "process.output" && processEvent.stream === "stdout") {
        stdoutBuffer += processEvent.chunk;
        const parsed = readJsonLines(stdoutBuffer);
        stdoutBuffer = parsed.remainder;
        for (const record of parsed.records) {
          const result = normalizeGooseRecord(record);
          completed ||= result.completed;
          if (result.text) {
            finalText += result.text;
            yield outputEvent(this.input, result.text);
          }
          for (const tool of result.tools) {
            yield toolEvent(this.input, tool);
          }
          if (result.tools.length > 0) {
            finalText = "";
          }
        }
      }

      if (processEvent.type === "process.completed") {
        if (stdoutBuffer.trim()) {
          for (const record of readJsonLines(`${stdoutBuffer}\n`).records) {
            const result = normalizeGooseRecord(record);
            completed ||= result.completed;
            if (result.text) {
              finalText += result.text;
              yield outputEvent(this.input, result.text);
            }
            for (const tool of result.tools) {
              yield toolEvent(this.input, tool);
            }
            if (result.tools.length > 0) {
              finalText = "";
            }
          }
        }

        if (processEvent.exitCode === 0 && !completed) {
          throw new Error("Goose exited without a stream completion event");
        }

        yield {
          agentRuntimeId: "goose",
          agentRunId: this.input.agentRunId,
          exitCode: processEvent.exitCode,
          finalText: finalText || null,
          sandboxLeaseId: this.input.sandboxLeaseId,
          type: "agent.completed",
        };
        return;
      }
    }

    throw new Error("Goose process ended without process completion");
  }
}

type NormalizedGooseRecord = {
  completed: boolean;
  text: string;
  tools: string[];
};

function normalizeGooseRecord(record: unknown): NormalizedGooseRecord {
  if (!isRecord(record) || typeof record.type !== "string") {
    throw new Error("Goose emitted an invalid stream-json record");
  }
  if (record.type === "complete") {
    return { completed: true, text: "", tools: [] };
  }
  if (record.type === "error") {
    throw new Error("Goose reported an execution error");
  }
  if (record.type === "notification") {
    return { completed: false, text: "", tools: [] };
  }
  if (record.type !== "message" || !isRecord(record.message)) {
    throw new Error("Goose emitted an unsupported stream-json record");
  }

  const message = record.message;
  if (message.role !== "assistant") {
    return { completed: false, text: "", tools: [] };
  }
  if (!Array.isArray(message.content)) {
    throw new Error("Goose emitted an invalid assistant message");
  }
  if (isRecord(message.metadata) && message.metadata.userVisible === false) {
    return { completed: false, text: "", tools: [] };
  }

  const text: string[] = [];
  const tools: string[] = [];
  for (const content of message.content) {
    if (!isRecord(content) || typeof content.type !== "string") {
      throw new Error("Goose emitted invalid message content");
    }
    if (content.type === "text") {
      if (typeof content.text !== "string") {
        throw new Error("Goose emitted invalid text content");
      }
      text.push(content.text);
      continue;
    }
    if (content.type === "toolRequest") {
      const tool = readGooseToolName(content);
      if (tool) {
        tools.push(tool);
      }
    }
  }

  return { completed: false, text: text.join(""), tools };
}

function readGooseToolName(content: Record<string, unknown>) {
  if (
    !isRecord(content.toolCall) ||
    content.toolCall.status !== "success" ||
    !isRecord(content.toolCall.value) ||
    typeof content.toolCall.value.name !== "string"
  ) {
    return null;
  }
  return content.toolCall.value.name;
}

function createGooseArguments(input: AgentRunInput, promptPath: string) {
  return [
    "run",
    "--no-session",
    "--no-profile",
    "--with-builtin",
    "developer",
    "--max-turns",
    String(gooseMaxTurns),
    "--provider",
    modelProviderId,
    "--model",
    requireModelAccess(input).modelId,
    "--quiet",
    "--output-format",
    "stream-json",
    "--instructions",
    promptPath,
  ];
}

function createProviderConfiguration(modelAccess: NonNullable<AgentRunInput["modelAccess"]>) {
  return {
    api_key_env: "AGENT_ONLINE_GATEWAY_TOKEN",
    base_url: modelGatewayChatCompletionsUrl(modelAccess.baseUrl),
    description: "Run-scoped Agent Online ModelGateway",
    display_name: "Agent Online",
    dynamic_models: false,
    engine: "openai",
    models: [
      {
        context_limit: 128_000,
        name: modelAccess.modelId,
        reasoning: false,
      },
    ],
    name: modelProviderId,
    preserves_thinking: true,
    requires_auth: true,
    skip_canonical_filtering: true,
    supports_streaming: true,
  };
}

function modelGatewayChatCompletionsUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
  ) {
    throw new Error("Goose ModelGateway baseUrl must use HTTPS outside local development");
  }

  url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function getGooseRunRoot(agentRunId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(agentRunId)) {
    throw new Error("AgentRun ID is not safe for a Goose config path");
  }
  return `${gooseConfigRoot}/${agentRunId}`;
}

function requireModelAccess(input: AgentRunInput) {
  if (!input.modelAccess) {
    throw new Error("Goose requires Run-scoped ModelGateway access");
  }
  return input.modelAccess;
}

function outputEvent(input: AgentRunInput, chunk: string): AgentEvent {
  return {
    agentRuntimeId: "goose",
    agentRunId: input.agentRunId,
    chunk,
    sandboxLeaseId: input.sandboxLeaseId,
    type: "agent.output",
  };
}

function toolEvent(input: AgentRunInput, tool: string): AgentEvent {
  return {
    agentRuntimeId: "goose",
    agentRunId: input.agentRunId,
    sandboxLeaseId: input.sandboxLeaseId,
    tool,
    type: "agent.tool.started",
  };
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
      throw new Error("Goose emitted malformed stream-json");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
