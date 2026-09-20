import { expect, test } from "@playwright/test";
import { registerAndCreateProject } from "./browser-fixture";

// Keep real React Query/HTTP behavior, control only the external SSE transport.
test("reduces healthy polling, recovers after a broken SSE and refreshes terminal facts once", async ({
  page,
}) => {
  await registerAndCreateProject(page, "run-sync");
  await page.addInitScript(() => {
    const streams: {
      onmessage: ((event: MessageEvent) => void) | null;
      onerror: (() => void) | null;
      readyState: number;
    }[] = [];
    Object.assign(window, { testStreams: streams });
    class ControlledEventSource {
      static CLOSED = 2;
      readyState = 1;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        streams.push(this);
      }
      close() {
        this.readyState = 2;
      }
    }
    Object.assign(window, { EventSource: ControlledEventSource });
  });
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    modelRequestCount: 0,
    sandboxDurationMs: 0,
  };
  const run = {
    id: "sync-run",
    createdAt: "2026-09-20T00:00:00.000Z",
    startedAt: null,
    finishedAt: null as string | null,
    agentRuntimeId: "pi",
    failureCode: null,
    inputMessageId: null,
    modelId: "test-model",
    sandboxLeaseId: "test-lease",
    sandboxRuntimeId: "fake",
    status: "queued",
    usage,
  };
  const reads = { detail: 0, messages: 0, history: 0, active: 0 };
  await page.route("**/api/projects/*/agent-runs**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/active")) {
      reads.active += 1;
      return route.fulfill({ json: run.status === "succeeded" ? null : run });
    }
    if (path.endsWith("/sync-run")) {
      reads.detail += 1;
      return route.fulfill({ json: run });
    }
    if (path.endsWith("/agent-runs")) {
      reads.history += 1;
      return route.fulfill({ json: { items: [run], nextCursor: null } });
    }
    return route.continue();
  });
  await page.route("**/api/projects/*/messages*", async (route) => {
    reads.messages += 1;
    return route.fulfill({
      json: {
        items:
          run.status === "succeeded"
            ? [
                {
                  id: "final-message",
                  agentRunId: run.id,
                  content: "Synchronized final reply",
                  createdAt: run.createdAt,
                  role: "assistant",
                  sequence: 0,
                },
              ]
            : [],
        nextCursor: null,
      },
    });
  });
  await page.reload();
  const streamCount = () =>
    page.evaluate(() => (window as unknown as { testStreams: unknown[] }).testStreams.length);
  await expect.poll(streamCount).toBe(1);
  await expect(page.getByLabel("Agent task")).toBeDisabled();
  await page.clock.install();
  const emit = (event: unknown) =>
    page.evaluate((value) => {
      const source = (
        window as unknown as {
          testStreams: { onmessage: ((event: MessageEvent) => void) | null }[];
        }
      ).testStreams.at(-1);
      source?.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) }));
    }, event);
  run.status = "starting";
  await emit({ type: "run.status", status: "starting", sequence: 1 });
  run.status = "running";
  await emit({ type: "run.status", status: "running", sequence: 2 });
  await page.clock.runFor(100);
  const healthyReads = reads.detail;
  await page.clock.runFor(6000);
  expect(reads.detail).toBe(healthyReads);
  expect(await streamCount()).toBe(1);
  await page.clock.runFor(30000);
  await expect.poll(() => reads.detail).toBe(healthyReads + 1);
  await page.evaluate(() => {
    const source = (
      window as unknown as { testStreams: { readyState: number; onerror: (() => void) | null }[] }
    ).testStreams.at(-1);
    if (source) {
      source.readyState = 0;
      source.onerror?.();
    }
  });
  await expect(
    page.getByText("实时执行流暂不可用，正在继续查询任务状态。", { exact: true }).first(),
  ).toBeVisible();
  const brokenReads = reads.detail;
  await page.clock.runFor(2100);
  await expect.poll(() => reads.detail).toBe(brokenReads + 1);
  // A recovered event restores the long interval without rebuilding the subscription.
  await emit({ type: "run.status", status: "running", sequence: 3 });
  await page.clock.runFor(100);
  const recoveredReads = reads.detail;
  await page.clock.runFor(6000);
  expect(reads.detail).toBe(recoveredReads);
  const beforeCompletion = { ...reads };
  run.status = "succeeded";
  run.finishedAt = "2026-09-20T00:01:00.000Z";
  await page.evaluate((usageValue) => {
    const source = (
      window as unknown as { testStreams: { onmessage: ((event: MessageEvent) => void) | null }[] }
    ).testStreams.at(-1);
    source?.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "run.status", status: "succeeded", sequence: 4 }),
      }),
    );
    source?.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "run.completed", sequence: 5, usage: usageValue }),
      }),
    );
  }, usage);
  await expect(page.getByText("Synchronized final reply", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Agent task")).toBeEnabled();
  expect(reads.detail - beforeCompletion.detail).toBe(1);
  expect(reads.messages - beforeCompletion.messages).toBe(1);
  expect(reads.history - beforeCompletion.history).toBe(1);
  expect(reads.active - beforeCompletion.active).toBe(1);
  const terminalReads = reads.detail;
  await page.clock.runFor(60000);
  expect(reads.detail).toBe(terminalReads);
  expect(await streamCount()).toBe(1);
});
