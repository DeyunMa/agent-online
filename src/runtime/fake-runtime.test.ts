import { describe, expect, it } from "vitest";

import { FakeSandboxRuntime } from "./fake-runtime";

describe("FakeSandboxRuntime", () => {
  it("emits a stable Pi event sequence for one lease", async () => {
    const runtime = new FakeSandboxRuntime();
    const handle = await runtime.create({ projectId: "project_1", sandboxLeaseId: "lease_1" });
    const events = [];

    for await (const event of runtime.startPi(handle, { runId: "run_1" })) {
      events.push(event.type);
    }

    expect(events).toEqual(["pi.started", "tool.started", "pi.completed"]);
  });
});
