import { describe, expect, it } from "vitest";

import { FakeSandboxRuntime } from "../runtime/fake-runtime";
import type { AgentEvent } from "./contract";
import { piRuntime } from "./pi-runtime";

describe("piRuntime", () => {
  it("maps generic sandbox process output to AgentRuntime events", async () => {
    const sandbox = new FakeSandboxRuntime();
    const sandboxHandle = await sandbox.create({ projectId: "project_1", sandboxLeaseId: "lease_1" });
    const events: AgentEvent[] = [];

    for await (const event of piRuntime.start({ sandbox, sandboxHandle }, {
      projectId: "project_1",
      runId: "run_1",
      sandboxLeaseId: "lease_1",
      workingDirectory: "/workspace",
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["agent.started", "agent.output", "agent.completed"]);
    expect(events[1]).toMatchObject({ chunk: "Started pi --mode rpc in /workspace", type: "agent.output" });
    expect(events[2]).toMatchObject({ exitCode: 0, type: "agent.completed" });
  });
});
