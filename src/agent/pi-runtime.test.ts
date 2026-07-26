import { describe, expect, it } from "vitest";

import type { SandboxCommand, SandboxProcessEvent, SandboxProcessSession } from "../runtime/contract";
import type { AgentEvent, AgentExecutionContext } from "./contract";
import { piRuntime } from "./pi-runtime";

describe("piRuntime", () => {
  it("configures the Run-scoped model gateway and maps Pi JSONL to normalized events", async () => {
    const session = new TestSandboxProcessSession([
      output([
        JSON.stringify({ command: "prompt", success: true, type: "response" }),
        JSON.stringify({
          assistantMessageEvent: { delta: "Hello ", type: "text_delta" },
          type: "message_update",
        }),
      ].join("\n") + "\n"),
      output(JSON.stringify({ toolName: "bash", type: "tool_execution_start" }) + "\n"),
      output([
        JSON.stringify({
          assistantMessageEvent: { delta: "world", type: "text_delta" },
          type: "message_update",
        }),
        JSON.stringify({ type: "agent_settled" }),
        "",
      ].join("\n")),
    ]);
    const context = new TestAgentExecutionContext(session);
    const execution = await piRuntime.start(context, {
      agentRunId: "run_1",
      modelAccess: {
        baseUrl: "https://agent-online.test/api/model-gateway/v1",
        bearerToken: "run-capability",
        maxOutputTokens: 512,
        modelId: "gemini-2.5-flash",
      },
      projectId: "project_1",
      prompt: "Create a hello world app.",
      sandboxLeaseId: "lease_1",
      workingDirectory: "/workspace",
    });
    const events: AgentEvent[] = [];

    for await (const event of execution.events()) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "agent.started",
      "agent.output",
      "agent.tool.started",
      "agent.output",
      "agent.completed",
    ]);
    expect(events.at(-1)).toMatchObject({
      exitCode: 0,
      finalText: "Hello world",
      type: "agent.completed",
    });
    expect(context.command).toMatchObject({
      args: [
        "--mode",
        "rpc",
        "--no-session",
        "--provider",
        "agent-online",
        "--model",
        "gemini-2.5-flash",
      ],
      command: "pi",
      env: {
        AGENT_ONLINE_GATEWAY_TOKEN: "run-capability",
        PI_CODING_AGENT_DIR: "/tmp/agent-online-pi/run_1",
      },
    });
    expect(context.fileWrites).toHaveLength(1);
    expect(context.fileWrites[0]?.path).toBe(
      "/tmp/agent-online-pi/run_1/models.json",
    );
    expect(context.fileWrites[0]?.content).toContain("https://agent-online.test/api/model-gateway/v1");
    expect(context.fileWrites[0]?.content).toContain("$AGENT_ONLINE_GATEWAY_TOKEN");
    expect(context.fileWrites[0]?.content).not.toContain("run-capability");
    expect(session.writes[0]).toBe(
      `${JSON.stringify({ id: "run_1", message: "Create a hello world app.", type: "prompt" })}\n`,
    );
    expect(session.terminations).toEqual(["completed"]);
  });

  it("sends an RPC abort before terminating a cancelled process", async () => {
    const session = new TestSandboxProcessSession([
      { exitCode: 143, sandboxLeaseId: "lease_1", type: "process.completed" },
    ]);
    const context = new TestAgentExecutionContext(session);
    const execution = await piRuntime.start(context, {
      agentRunId: "run_1",
      projectId: "project_1",
      prompt: "Stop soon.",
      sandboxLeaseId: "lease_1",
      workingDirectory: "/workspace",
    });

    await execution.cancel("cancelled");
    const events: AgentEvent[] = [];
    for await (const event of execution.events()) {
      events.push(event);
    }

    expect(session.writes.at(-1)).toBe(`${JSON.stringify({ type: "abort" })}\n`);
    expect(session.terminations).toEqual(["cancelled"]);
    expect(events.at(-1)).toMatchObject({
      exitCode: 143,
      finalText: null,
      type: "agent.completed",
    });
  });

  it("fails closed when Pi emits malformed RPC output", async () => {
    const session = new TestSandboxProcessSession([output("not-json\n")]);
    const context = new TestAgentExecutionContext(session);
    const execution = await piRuntime.start(context, {
      agentRunId: "run_1",
      projectId: "project_1",
      prompt: "Inspect the project.",
      sandboxLeaseId: "lease_1",
      workingDirectory: "/workspace",
    });

    await expect(collect(execution.events())).rejects.toThrow("malformed JSONL");
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

function output(chunk: string): SandboxProcessEvent {
  return {
    chunk,
    sandboxLeaseId: "lease_1",
    stream: "stdout",
    type: "process.output",
  };
}

async function collect<T>(events: AsyncIterable<T>) {
  const values: T[] = [];
  for await (const event of events) {
    values.push(event);
  }
  return values;
}
