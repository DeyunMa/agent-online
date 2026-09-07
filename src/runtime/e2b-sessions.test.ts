import { describe, expect, it, vi } from "vitest";
import type { CommandStartOpts } from "e2b";
import { processOutputLimits, startE2BProcessSession } from "./e2b-sessions";
import type { E2BSandbox } from "./e2b-types";

function fixture(beforeStart?: (options: CommandStartOpts) => void) {
  let callbacks: CommandStartOpts = {};
  const process = {
    pid: 42,
    disconnect: vi.fn(async () => undefined),
    kill: vi.fn(async () => true),
    sendStdin: vi.fn(async () => undefined),
    wait: () => new Promise<never>(() => undefined),
  };
  const sandbox = {
    commands: {
      run: async (_command: string, options: CommandStartOpts) => {
        callbacks = options;
        beforeStart?.(options);
        return process;
      },
    },
  } as unknown as E2BSandbox;
  return {
    process,
    output: (chunk: string, stream: "stdout" | "stderr" = "stdout") =>
      stream === "stdout" ? callbacks.onStdout?.(chunk) : callbacks.onStderr?.(chunk),
    start: () =>
      startE2BProcessSession(
        sandbox,
        { sandboxLeaseId: "lease_1", id: "private", kind: "e2b" },
        { agentRunId: "run_1", command: "pi", args: [], cwd: "/workspace" },
        1000,
      ),
  };
}

describe("E2B process output limits", () => {
  it("bounds output received before the command handle exists and kills it once acquired", async () => {
    const test = fixture((options) => {
      options.onStdout?.("x".repeat(processOutputLimits.pendingBytes + 1));
    });
    await expect(test.start()).rejects.toThrow("output limit exceeded");
    expect(test.process.kill).toHaveBeenCalledOnce();
    expect(test.process.disconnect).toHaveBeenCalledOnce();
  });

  it("fails a slow consumer and discards queued output", async () => {
    const test = fixture();
    const session = await test.start();
    const events = session.events()[Symbol.asyncIterator]();
    await events.next();
    test.output("x".repeat(processOutputLimits.pendingBytes));
    test.output("界", "stderr");
    await expect(events.next()).rejects.toThrow("output limit exceeded");
    expect(test.process.kill).toHaveBeenCalledOnce();
    expect(test.process.disconnect).toHaveBeenCalledOnce();
  });

  it("still attempts kill when stream disconnect rejects", async () => {
    const test = fixture();
    test.process.disconnect.mockRejectedValue(new Error("disconnect failed"));
    const session = await test.start();
    test.output("x".repeat(processOutputLimits.pendingBytes + 1));
    await expect(session.events()[Symbol.asyncIterator]().next()).rejects.toThrow(
      "output limit exceeded",
    );
    expect(test.process.kill).toHaveBeenCalledOnce();
  });

  it("bounds tiny event floods as well as bytes", async () => {
    const test = fixture();
    const session = await test.start();
    for (let index = 0; index <= processOutputLimits.pendingEvents; index++) test.output("x");
    await expect(session.events()[Symbol.asyncIterator]().next()).rejects.toThrow(
      "output limit exceeded",
    );
    expect(test.process.kill).toHaveBeenCalledOnce();
  });

  it("bounds cumulative stdout and stderr even when the consumer keeps up", async () => {
    const test = fixture();
    const session = await test.start();
    const events = session.events()[Symbol.asyncIterator]();
    await events.next();
    const chunk = "x".repeat(1024 * 1024);
    for (let index = 0; index < processOutputLimits.totalBytes / chunk.length; index++) {
      test.output(chunk, index % 2 ? "stderr" : "stdout");
      expect((await events.next()).done).toBe(false);
    }
    test.output("x");
    await expect(events.next()).rejects.toThrow("output limit exceeded");
    expect(test.process.kill).toHaveBeenCalledOnce();
  });
});
