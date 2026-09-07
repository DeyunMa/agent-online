import { describe, expect, it } from "vitest";

import type {
  SandboxCommand,
  SandboxProcessEvent,
  SandboxProcessSession,
} from "../runtime/contract";
import type { AgentEvent, AgentExecutionContext, AgentRunInput } from "./contract";
import { maxAgentFinalTextBytes, maxAgentRecordBytes } from "./json-lines";
import { gooseRuntime } from "./goose-runtime";

describe("gooseRuntime", () => {
  it("configures a Run-scoped provider and maps Goose stream-json events", async () => {
    const session = new TestSandboxProcessSession([
      output(
        `${JSON.stringify(
          messageRecord({
            content: [{ text: "Working", type: "text" }],
            id: "message_1",
          }),
        )}\n${JSON.stringify(
          messageRecord({
            content: [
              {
                id: "tool_1",
                toolCall: {
                  status: "success",
                  value: {
                    arguments: { path: "demo.txt" },
                    name: "developer__shell",
                  },
                },
                type: "toolRequest",
              },
            ],
            id: "message_2",
          }),
        )}\n`,
      ),
      output(
        `${JSON.stringify(
          messageRecord({
            content: [{ text: "Done", type: "text" }],
            id: "message_3",
          }),
        )}\n${JSON.stringify(
          messageRecord({
            content: [{ text: " completely", type: "text" }],
            id: "message_4",
          }),
        )}\n${JSON.stringify({ total_tokens: 42, type: "complete" })}\n`,
      ),
      {
        exitCode: 0,
        sandboxLeaseId: "lease_1",
        type: "process.completed",
      },
    ]);
    const context = new TestAgentExecutionContext(session);
    const execution = await gooseRuntime.start(context, runInput());
    const events = await collect(execution.events());

    expect(events.map((event) => event.type)).toEqual([
      "agent.started",
      "agent.output",
      "agent.tool.started",
      "agent.output",
      "agent.output",
      "agent.completed",
    ]);
    expect(events.at(-1)).toMatchObject({
      agentRuntimeId: "goose",
      exitCode: 0,
      finalText: "Done completely",
      type: "agent.completed",
    });
    expect(context.command).toMatchObject({
      args: [
        "run",
        "--no-session",
        "--no-profile",
        "--with-builtin",
        "developer",
        "--max-turns",
        "25",
        "--provider",
        "agent_online",
        "--model",
        "gemini-3.6-flash",
        "--quiet",
        "--output-format",
        "stream-json",
        "--instructions",
        "/tmp/agent-online-goose/run_1/prompt.md",
      ],
      command: "goose",
      cwd: "/workspace",
      env: {
        AGENT_ONLINE_GATEWAY_TOKEN: "run-capability",
        GOOSE_CONTEXT_STRATEGY: "summarize",
        GOOSE_DISABLE_SESSION_NAMING: "true",
        GOOSE_MAX_TURNS: "25",
        GOOSE_MODE: "auto",
        GOOSE_PATH_ROOT: "/tmp/agent-online-goose/run_1",
      },
    });
    expect(context.fileWrites).toHaveLength(2);
    const providerWrite = context.fileWrites.find((write) =>
      write.path.endsWith("/agent_online.json"),
    );
    const promptWrite = context.fileWrites.find((write) => write.path.endsWith("/prompt.md"));
    expect(providerWrite?.content).toContain(
      "https://agent-online.test/api/model-gateway/v1/chat/completions",
    );
    expect(providerWrite?.content).toContain('"api_key_env":"AGENT_ONLINE_GATEWAY_TOKEN"');
    expect(providerWrite?.content).not.toContain("run-capability");
    expect(promptWrite?.content).toBe("Inspect and update the project.");
    expect(JSON.stringify(context.command?.args)).not.toContain("Inspect and update the project.");
  });

  it.each([
    ["unterminated record", ["x".repeat(maxAgentRecordBytes + 1)]],
    [
      "accumulated final reply",
      [1, 2].map(
        () =>
          JSON.stringify(
            messageRecord({
              id: "reply",
              content: [{ type: "text", text: "x".repeat(maxAgentFinalTextBytes / 2 + 1) }],
            }),
          ) + "\n",
      ),
    ],
  ])("terminates on an oversized %s", async (_name, chunks) => {
    const session = new TestSandboxProcessSession(chunks.map(output));
    const execution = await gooseRuntime.start(new TestAgentExecutionContext(session), runInput());
    await expect(collect(execution.events())).rejects.toThrow("limit exceeded");
    expect(session.terminations).toEqual(["failed"]);
  });

  it.each([true, false])(
    "discards intermediate text after failed tool requests (visible: %s)",
    async (userVisible) => {
      const failedTool = messageRecord({
        id: "tool",
        content: [{ type: "toolRequest", toolCall: { status: "error", error: "unavailable" } }],
      });
      failedTool.message.metadata.userVisible = userVisible;
      const records = [
        messageRecord({ id: "working", content: [{ type: "text", text: "Working" }] }),
        failedTool,
        messageRecord({ id: "done", content: [{ type: "text", text: "Done" }] }),
        { type: "complete" },
      ];
      const session = new TestSandboxProcessSession([
        output(records.map((record) => JSON.stringify(record)).join("\n") + "\n"),
        { type: "process.completed", sandboxLeaseId: "lease_1", exitCode: 0 },
      ]);
      const execution = await gooseRuntime.start(
        new TestAgentExecutionContext(session),
        runInput(),
      );
      expect((await collect(execution.events())).at(-1)).toMatchObject({
        finalText: "Done",
        exitCode: 0,
      });
    },
  );

  it("terminates the Goose process without writing to stdin when cancelled", async () => {
    const session = new TestSandboxProcessSession([]);
    const execution = await gooseRuntime.start(new TestAgentExecutionContext(session), runInput());

    await execution.cancel("cancelled");

    expect(session.terminations).toEqual(["cancelled"]);
    expect(session.writes).toEqual([]);
  });

  it("fails closed when Goose exits without its completion record", async () => {
    const session = new TestSandboxProcessSession([
      output(
        `${JSON.stringify(
          messageRecord({
            content: [{ text: "Incomplete", type: "text" }],
            id: "message_1",
          }),
        )}\n`,
      ),
      {
        exitCode: 0,
        sandboxLeaseId: "lease_1",
        type: "process.completed",
      },
    ]);
    const execution = await gooseRuntime.start(new TestAgentExecutionContext(session), runInput());

    await expect(collect(execution.events())).rejects.toThrow("without a stream completion event");
  });

  it("rejects non-HTTPS ModelGateway URLs outside local development", async () => {
    const input = runInput();
    if (!input.modelAccess) {
      throw new Error("Test input requires ModelGateway access");
    }
    input.modelAccess = {
      ...input.modelAccess,
      baseUrl: "http://agent-online.test/api/model-gateway/v1",
    };

    await expect(
      gooseRuntime.start(new TestAgentExecutionContext(new TestSandboxProcessSession([])), input),
    ).rejects.toThrow("must use HTTPS");
  });
});

class TestAgentExecutionContext implements AgentExecutionContext {
  command: SandboxCommand | null = null;
  readonly fileWrites: Array<{ content: string; path: string }> = [];

  constructor(private readonly session: SandboxProcessSession) {}

  readonly processes = {
    start: async (command: SandboxCommand) => {
      this.command = command;
      return this.session;
    },
  };

  readonly files = {
    write: async (path: string, content: string) => {
      this.fileWrites.push({ content, path });
    },
  };
}

class TestSandboxProcessSession implements SandboxProcessSession {
  readonly providerProcessRef = "process_1";
  readonly terminations: string[] = [];
  readonly writes: string[] = [];

  constructor(private readonly processEvents: SandboxProcessEvent[]) {}

  async *events() {
    yield* this.processEvents;
  }

  async terminate(reason: "completed" | "cancelled" | "timed_out" | "failed") {
    this.terminations.push(reason);
  }

  async write(input: string) {
    this.writes.push(input);
  }
}

function runInput(): AgentRunInput {
  return {
    agentRunId: "run_1",
    modelAccess: {
      baseUrl: "https://agent-online.test/api/model-gateway/v1",
      bearerToken: "run-capability",
      maxOutputTokens: 512,
      modelId: "gemini-3.6-flash",
    },
    projectId: "project_1",
    prompt: "Inspect and update the project.",
    sandboxLeaseId: "lease_1",
    workingDirectory: "/workspace",
  };
}

function messageRecord(input: { content: unknown[]; id: string }) {
  return {
    message: {
      content: input.content,
      created: 1,
      id: input.id,
      metadata: { agentVisible: true, userVisible: true },
      role: "assistant",
    },
    type: "message",
  };
}

function output(chunk: string): SandboxProcessEvent {
  return {
    chunk,
    sandboxLeaseId: "lease_1",
    stream: "stdout",
    type: "process.output",
  };
}

async function collect(events: AsyncIterable<AgentEvent>) {
  const values: AgentEvent[] = [];
  for await (const event of events) {
    values.push(event);
  }
  return values;
}
