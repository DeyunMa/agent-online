import { describe, expect, it } from "vitest";

import { FakeSandboxRuntime } from "./fake-runtime";

describe("FakeSandboxRuntime", () => {
  it("executes a generic command with a stable process event sequence", async () => {
    const runtime = new FakeSandboxRuntime();
    const handle = await runtime.ensureLease({
      projectId: "project_1",
      providerRef: null,
      sandboxLeaseId: "lease_1",
    });
    const session = await runtime.startProcess(handle, {
      agentRunId: "run_1",
      args: ["--mode", "rpc"],
      command: "pi",
      cwd: "/workspace",
    });
    const events = [];

    for await (const event of session.events()) {
      events.push(event.type);
    }

    expect(events).toEqual(["process.started", "process.output", "process.completed"]);
  });

  it("terminates a process session without stopping the whole lease", async () => {
    const runtime = new FakeSandboxRuntime();
    const handle = await runtime.ensureLease({
      projectId: "project_1",
      providerRef: null,
      sandboxLeaseId: "lease_1",
    });
    const session = await runtime.startProcess(handle, {
      agentRunId: "run_1",
      args: [],
      command: "pi",
      cwd: "/workspace",
    });

    await session.terminate("cancelled");
    const events = [];

    for await (const event of session.events()) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["process.started", "process.completed"]);
    expect(events.at(-1)).toMatchObject({ exitCode: 143, type: "process.completed" });

    await expect(
      runtime.startProcess(handle, {
        agentRunId: "run_2",
        args: [],
        command: "pi",
        cwd: "/workspace",
      }),
    ).resolves.toBeDefined();
  });

  it("observes cancellation while a delayed fake process is still active", async () => {
    const runtime = new FakeSandboxRuntime({ completionDelayMs: 20 });
    const handle = await runtime.ensureLease({
      projectId: "project_1",
      providerRef: null,
      sandboxLeaseId: "lease_1",
    });
    const session = await runtime.startProcess(handle, {
      agentRunId: "run_1",
      args: [],
      command: "pi",
      cwd: "/workspace",
    });
    const iterator = session.events()[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "process.started" } });
    const completion = iterator.next();
    await session.terminate("cancelled");

    await expect(completion).resolves.toMatchObject({
      value: { exitCode: 143, type: "process.completed" },
    });
  });

  it("reuses the private provider reference supplied by the current Lease", async () => {
    const runtime = new FakeSandboxRuntime();

    const handle = await runtime.ensureLease({
      projectId: "project_1",
      providerRef: "fake-existing-lease",
      sandboxLeaseId: "lease_1",
    });

    expect(handle).toEqual({ id: "fake-existing-lease", kind: "fake", sandboxLeaseId: "lease_1" });
  });

  it("lists, reads, and removes files with the sandbox lifecycle", async () => {
    const runtime = new FakeSandboxRuntime();
    const handle = await runtime.ensureLease({
      projectId: "project_1",
      providerRef: null,
      sandboxLeaseId: "lease_1",
    });
    await runtime.writeFile(handle, "/workspace/src/index.ts", "export {};\n");

    await expect(runtime.listDirectory(handle, "/workspace")).resolves.toEqual([
      {
        kind: "directory",
        modifiedAt: null,
        name: "src",
        size: 0,
      },
    ]);
    await expect(runtime.readFile(handle, "/workspace/src/index.ts")).resolves.toEqual(
      new TextEncoder().encode("export {};\n"),
    );

    await runtime.stop(handle, "manual");
    await expect(runtime.readFile(handle, "/workspace/src/index.ts")).rejects.toThrow(
      "Unknown fake runtime handle",
    );
  });
});
