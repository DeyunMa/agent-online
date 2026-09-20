import { expect, test } from "@playwright/test";
import { registerAndCreateProject } from "./browser-fixture";

test("loads additional Project and Run pages in the UI", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await registerAndCreateProject(page, "list-pages");
  const at = "2026-09-20T00:00:00.000Z";
  await page.route(/\/api\/projects(?:\?|$)/, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    const start = cursor ? 50 : 0;
    const items = Array.from({ length: cursor ? 5 : 50 }, (_, offset) => ({
      id: `paged-project-${start + offset}`,
      title: `Paged project ${start + offset}`,
      createdAt: at,
      updatedAt: at,
      defaultAgentRuntimeId: "pi",
      sandboxLease: null,
    }));
    await route.fulfill({
      json: { items, nextCursor: cursor ? null : { at, id: "paged-project-49" } },
    });
  });
  await page.route("**/api/projects/*/agent-runs*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith("/agent-runs")) return route.continue();
    const cursor = url.searchParams.get("cursor");
    const start = cursor ? 50 : 0;
    const items = Array.from({ length: cursor ? 5 : 50 }, (_, offset) => ({
      id: `paged-run-${start + offset}`,
      createdAt: at,
      finishedAt: at,
      startedAt: null,
      agentRuntimeId: "pi",
      failureCode: null,
      inputMessageId: null,
      modelId: "test-model",
      sandboxLeaseId: "test-lease",
      sandboxRuntimeId: "fake",
      status: "cancelled",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        modelRequestCount: 0,
        sandboxDurationMs: 0,
      },
    }));
    await route.fulfill({
      json: { items, nextCursor: cursor ? null : { at, id: "paged-run-49" } },
    });
  });
  await page.reload();
  const sidebar = page.locator(".project-sidebar");
  await expect(sidebar.locator(".project-sidebar-link")).toHaveCount(50);
  await sidebar.getByRole("button", { name: "Load more projects" }).click();
  await expect(sidebar.locator(".project-sidebar-link")).toHaveCount(55);
  await expect(sidebar.getByRole("button", { name: "Load more projects" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Runs", exact: true }).click();
  await expect(page.locator(".run-history-entry")).toHaveCount(50);
  await page.getByRole("button", { name: "Load more runs" }).click();
  await expect(page.locator(".run-history-entry")).toHaveCount(55);
  await expect(page.getByRole("button", { name: "Load more runs" })).toHaveCount(0);
});

for (const width of [1440, 390]) {
  test(`loads message history without moving the reading anchor at ${width}px`, async ({
    page,
  }) => {
    let count = 120;
    const incrementalCursors: number[] = [];
    await page.route("**/api/projects/*/messages*", async (route) => {
      const params = new URL(route.request().url()).searchParams;
      const after = params.get("after");
      const before = params.get("before");
      let rows = Array.from({ length: count }, (_, index) => ({
        agentRunId: null,
        content: `History message ${index + 1}`,
        createdAt: "2026-09-20T00:00:00.000Z",
        id: `message-${index + 1}`,
        role: "user",
        sequence: index + 1,
      }));
      if (after !== null) {
        incrementalCursors.push(Number(after));
        rows = rows.filter((row) => row.sequence > Number(after));
        const items = rows.slice(0, 50);
        await route.fulfill({
          json: { items, nextCursor: rows.length > 50 ? items.at(-1)?.sequence : null },
        });
      } else {
        if (before !== null) rows = rows.filter((row) => row.sequence < Number(before));
        const items = rows.slice(-50);
        await route.fulfill({
          json: { items, nextCursor: rows.length > 50 ? items[0]?.sequence : null },
        });
      }
    });
    await page.setViewportSize({ width, height: 900 });
    await registerAndCreateProject(page, "pagination");
    const rows = page.locator(".timeline-message");
    await expect(rows).toHaveCount(50);
    const load = page.getByRole("button", { name: "Load earlier messages" });
    await load.scrollIntoViewIfNeeded();
    const anchor = page.getByText("History message 71", { exact: true });
    const before = await anchor.boundingBox();
    expect(before).not.toBeNull();
    await load.click();
    await expect(rows).toHaveCount(100);
    await expect
      .poll(async () => Math.abs(((await anchor.boundingBox())?.y ?? 0) - (before?.y ?? 0)))
      .toBeLessThan(3);
    count = 180;
    await page.context().setOffline(true);
    await page.context().setOffline(false);
    await expect(rows).toHaveCount(160);
    expect(incrementalCursors).toContain(120);
    expect(incrementalCursors).toContain(170);
    await load.click();
    await expect(rows).toHaveCount(180);
    await expect(load).toHaveCount(0);
    expect(await rows.locator(".timeline-message-copy").allTextContents()).toEqual(
      Array.from({ length: 180 }, (_, index) => `History message ${index + 1}`),
    );
  });
}
