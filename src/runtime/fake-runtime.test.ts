import { describe, expect, it } from "vitest";

import { FakeSandboxRuntime } from "./fake-runtime";

describe("FakeSandboxRuntime", () => {
  it("executes a generic command with a stable process event sequence", async () => {
    const runtime = new FakeSandboxRuntime();
    const handle = await runtime.create({ projectId: "project_1", sandboxLeaseId: "lease_1" });
    const events = [];

    for await (const event of runtime.execute(handle, {
      args: ["--mode", "rpc"],
      command: "pi",
      cwd: "/workspace",
      runId: "run_1",
    })) {
      events.push(event.type);
    }

    expect(events).toEqual(["process.started", "process.output", "process.completed"]);
  });
});
