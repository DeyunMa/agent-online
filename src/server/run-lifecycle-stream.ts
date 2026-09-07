import type { SSEStreamingApi } from "hono/streaming";

import type { AgentRunRecord } from "../application/ports";
import { isTerminalAgentRun } from "../domain/agent-run";
import type { AgentRunStreamEvent } from "../shared/api";

const initialPollIntervalMs = 750;
const maximumPollIntervalMs = 5_000;
const heartbeatIntervalMs = 15_000;

type LifecycleRun = Pick<AgentRunRecord, "status" | "usage">;
type LifecycleStream = Pick<SSEStreamingApi, "aborted" | "onAbort" | "writeSSE"> & {
  write(data: string): Promise<unknown>;
};

/** Poll only owned Run state; comments keep idle connections alive without changing the API. */
export async function streamRunLifecycle(
  stream: LifecycleStream,
  initialRun: LifecycleRun,
  readRun: () => Promise<LifecycleRun | null>,
) {
  const controller = new AbortController();
  stream.onAbort(() => controller.abort());
  if (stream.aborted) controller.abort();
  const { signal } = controller;
  if (signal.aborted) return;

  let run = initialRun;
  let sequence = 0;
  let interval = initialPollIntervalMs;
  let nextHeartbeat = Date.now() + heartbeatIntervalMs;
  let nextPoll = Date.now() + interval;
  const writeEvent = (event: AgentRunStreamEvent) =>
    stream.writeSSE({ data: JSON.stringify(event) });

  await writeEvent({ sequence: sequence++, status: run.status, type: "run.status" });

  while (!signal.aborted && !isTerminalAgentRun(run.status)) {
    await waitUntil(Math.min(nextPoll, nextHeartbeat), signal);
    if (signal.aborted) return;

    if (Date.now() >= nextHeartbeat) {
      await stream.write(": heartbeat\n\n");
      nextHeartbeat = Date.now() + heartbeatIntervalMs;
      if (signal.aborted) return;
    }
    if (Date.now() < nextPoll) continue;

    const updated = await readRun();
    // D1 reads cannot be cancelled, but a disconnect must prevent subsequent writes/reads.
    if (signal.aborted || !updated) return;
    if (updated.status !== run.status) {
      interval = initialPollIntervalMs;
      await writeEvent({ sequence: sequence++, status: updated.status, type: "run.status" });
    } else {
      interval = Math.min(interval * 2, maximumPollIntervalMs);
    }
    run = updated;
    nextPoll = Date.now() + interval;
  }

  if (!signal.aborted) {
    await writeEvent({ sequence, type: "run.completed", usage: run.usage });
  }
}

function waitUntil(time: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, time - Date.now()));
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
