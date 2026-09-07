import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRunRecord } from "../application/ports";
import type { AgentRunStreamEvent } from "../shared/api";
import { streamRunLifecycle } from "./run-lifecycle-stream";

type Run = Pick<AgentRunRecord, "status" | "usage">;
const queued: Run = {
  status: "queued",
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    modelRequestCount: 0,
    sandboxDurationMs: 0,
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function createStream() {
  const events: AgentRunStreamEvent[] = [];
  let onAbort = () => {};
  const stream = {
    aborted: false,
    onAbort: (listener: () => void) => {
      onAbort = listener;
    },
    write: vi.fn(async (_data: string) => undefined),
    writeSSE: vi.fn(async ({ data }: { data: string | Promise<string> }) => {
      events.push(JSON.parse(await data) as AgentRunStreamEvent);
    }),
  };
  return {
    stream,
    events,
    abort() {
      stream.aborted = true;
      onAbort();
    },
  };
}

describe("Run lifecycle stream", () => {
  it("reduces thirty minutes of stable Run polling to 361 owned reads", async () => {
    const fixture = createStream();
    const read = vi.fn(async () => queued);
    const done = streamRunLifecycle(fixture.stream, queued, read);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
    expect(read).toHaveBeenCalledTimes(361);
    expect(fixture.events).toEqual([{ sequence: 0, status: "queued", type: "run.status" }]);
    expect(fixture.stream.write).toHaveBeenCalledTimes(120);
    fixture.abort();
    await done;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resets the fast polling interval after a status transition", async () => {
    const fixture = createStream();
    let current = queued;
    const read = vi.fn(async () => current);
    const done = streamRunLifecycle(fixture.stream, queued, read);
    await vi.advanceTimersByTimeAsync(5_250);
    expect(read).toHaveBeenCalledTimes(3);
    current = { ...queued, status: "starting" };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledTimes(4);
    expect(fixture.events.at(-1)).toEqual({ sequence: 1, status: "starting", type: "run.status" });
    await vi.advanceTimersByTimeAsync(749);
    expect(read).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(5);
    fixture.abort();
    await done;
  });

  it("sends comment heartbeats without reading D1 or consuming event sequence numbers", async () => {
    const fixture = createStream();
    const read = vi.fn(async () => queued);
    const done = streamRunLifecycle(fixture.stream, queued, read);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(read).toHaveBeenCalledTimes(4);
    expect(fixture.stream.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(4);
    expect(fixture.stream.write).toHaveBeenCalledWith(": heartbeat\n\n");
    expect(fixture.events).toHaveLength(1);
    fixture.abort();
    await done;
  });

  it("publishes final status and current usage once and stops all polling", async () => {
    const fixture = createStream();
    const final: Run = { status: "succeeded", usage: { ...queued.usage, totalTokens: 99 } };
    const read = vi.fn(async () => final);
    const done = streamRunLifecycle(fixture.stream, queued, read);
    await vi.advanceTimersByTimeAsync(750);
    await done;
    expect(fixture.events).toEqual([
      { sequence: 0, status: "queued", type: "run.status" },
      { sequence: 1, status: "succeeded", type: "run.status" },
      { sequence: 2, type: "run.completed", usage: final.usage },
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes an initially terminal Run without a query or timer", async () => {
    const fixture = createStream();
    const read = vi.fn(async () => queued);
    await streamRunLifecycle(fixture.stream, { ...queued, status: "cancelled" }, read);
    expect(fixture.events.map((event) => event.type)).toEqual(["run.status", "run.completed"]);
    expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending timer immediately when the consumer disconnects", async () => {
    const fixture = createStream();
    const read = vi.fn(async () => queued);
    const done = streamRunLifecycle(fixture.stream, queued, read);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(1);
    fixture.abort();
    await done;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).not.toHaveBeenCalled();
    expect(fixture.events).toHaveLength(1);
  });

  it("connects a real Hono response cancellation to timer cleanup", async () => {
    const read = vi.fn(async () => queued);
    const app = new Hono();
    let done: Promise<void> | undefined;
    app.get("/events", (c) =>
      streamSSE(c, (stream) => {
        done = streamRunLifecycle(stream, queued, read);
        return done;
      }),
    );
    const response = await app.request("/events");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Expected SSE response body");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"type":"run.status"');
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(1);
    await reader.cancel();
    await done;
    expect(vi.getTimerCount()).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it("discards an in-flight D1 result after disconnect", async () => {
    const fixture = createStream();
    let resolveRead!: (run: Run) => void;
    const read = vi.fn(
      () =>
        new Promise<Run>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const done = streamRunLifecycle(fixture.stream, queued, read);
    await vi.advanceTimersByTimeAsync(750);
    fixture.abort();
    resolveRead({ ...queued, status: "succeeded" });
    await done;
    expect(fixture.events).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledOnce();
  });

  it("closes without a completion event if the owned Run is no longer available", async () => {
    const fixture = createStream();
    const read = vi.fn(async () => null);
    const done = streamRunLifecycle(fixture.stream, queued, read);
    await vi.advanceTimersByTimeAsync(750);
    await done;
    expect(fixture.events).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
