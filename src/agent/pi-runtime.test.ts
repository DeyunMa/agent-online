import { describe, expect, it } from "vitest";

import { FakeSandboxRuntime } from "../runtime/fake-runtime";
import type { AgentEvent } from "./contract";
import { piRuntime } from "./pi-runtime";

describe("piRuntime", () => {
  it("maps a run-scoped sandbox process to AgentRuntime events", async () => {
    const sandbox = new FakeSandboxRuntime();
    const sandboxHandle = await sandbox.ensureLease({ projectId: "project_1", sandboxLeaseId: "lease_1" });
    const execution = await piRuntime.start({
      processes: {
        start: (command) => sandbox.startProcess(sandboxHandle, command),
      },
    }, {
      agentRunId: "run_1",
      projectId: "project_1",
      prompt: "Create a hello world app.",
      sandboxLeaseId: "lease_1",
      workingDirectory: "/workspace",
    });
    const events: AgentEvent[] = [];

    for await (const event of execution.events()) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["agent.started", "agent.output", "agent.completed"]);
    expect(events[1]).toMatchObject({ chunk: "Started pi --mode rpc in /workspace", type: "agent.output" });
    expect(events[2]).toMatchObject({ exitCode: 0, type: "agent.completed" });
  });

  it("forwards Run cancellation to the sandbox process session", async () => {
    const sandbox = new FakeSandboxRuntime();
    const sandboxHandle = await sandbox.ensureLease({ projectId: "project_1", sandboxLeaseId: "lease_1" });
    const execution = await piRuntime.start({
      processes: {
        start: (command) => sandbox.startProcess(sandboxHandle, command),
      },
    }, {
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

    expect(events.map((event) => event.type)).toEqual(["agent.started", "agent.completed"]);
    expect(events.at(-1)).toMatchObject({ exitCode: 143, type: "agent.completed" });
  });
});
