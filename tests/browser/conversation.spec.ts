import { expect, test } from "@playwright/test";
import { registerAndCreateProject } from "./browser-fixture";

test("preserves a failed draft, handles keyboard input and submits only once", async ({ page }) => {
  let requests = 0;
  let releaseFailure = () => {};
  const failureGate = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  await page.route("**/api/projects/*/agent-runs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    requests += 1;
    if (requests !== 1) return route.continue();
    await failureGate;
    await route.fulfill({
      status: 503,
      json: {
        error: { code: "internal.unexpected", message: "Temporary failure", retryable: true },
        requestId: "composer-test",
      },
    });
  });
  await registerAndCreateProject(page, "composer");
  const input = page.getByLabel("Agent task");
  const send = page.getByRole("button", { name: "Start run" });
  await input.fill("   ");
  await expect(send).toBeDisabled();
  await input.fill("保留这份草稿");
  await input.press("Enter");
  await expect(input).toHaveValue("保留这份草稿\n");
  await input.dispatchEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true });
  await input.dispatchEvent("keydown", { key: "Enter", metaKey: true, keyCode: 229 });
  expect(requests).toBe(0);
  await input.press("Control+Enter");
  await expect.poll(() => requests).toBe(1);
  await expect(input).toBeDisabled();
  await expect(send).toBeDisabled();
  await input.dispatchEvent("keydown", { key: "Enter", ctrlKey: true });
  expect(requests).toBe(1);
  releaseFailure();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("保留这份草稿\n");
  await expect(
    page.getByRole("alert").getByText("服务暂时无法完成请求，请稍后重试。"),
  ).toBeVisible();
  await input.press("Meta+Enter");
  await expect.poll(() => requests).toBe(2);
  await expect(input).toHaveValue("");
  await expect(
    page
      .getByRole("list", { name: "Project conversation" })
      .getByText("保留这份草稿", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel run" }).click();
  await expect(input).toBeEnabled({ timeout: 15_000 });
  await input.fill("This belongs to the first project");
  await page.getByRole("link", { name: "New project" }).first().click();
  await page.getByLabel("Project name").fill("A different project");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByLabel("Agent task")).toHaveValue("");
});

for (const width of [1440, 390]) {
  test(`follows new messages and preserves reading position at ${width}px`, async ({ page }) => {
    let count = 30;
    await page.route("**/api/projects/*/messages", (route) =>
      route.fulfill({
        json: Array.from({ length: count }, (_, index) => ({
          agentRunId: null,
          content: `Message ${index + 1}\n${"A paragraph in the conversation. ".repeat(12)}`,
          createdAt: "2026-09-09T00:00:00.000Z",
          id: `message-${index}`,
          role: "user",
          sequence: index + 1,
        })),
      }),
    );
    await page.setViewportSize({ width, height: 900 });
    await registerAndCreateProject(page, "scroll");
    const viewport = page.locator(
      width < 760 ? "html" : ".project-conversation-panel .project-console-scroll",
    );
    const bottomGap = () =>
      viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    await expect.poll(bottomGap).toBeLessThan(2);
    const scrollTo = (position: number | "bottom") =>
      viewport.evaluate(async (el, target) => {
        const top = target === "bottom" ? el.scrollHeight - el.clientHeight : target;
        if (el.scrollTop === top) return;
        // Geometry updates synchronously, but the component learns scroll intent
        // from the later scroll event. Finish that event before refetching.
        const events = el === document.scrollingElement ? document : el;
        await new Promise<void>((resolve) => {
          events.addEventListener("scroll", () => resolve(), { once: true });
          el.scrollTop = top;
        });
      }, position);
    await scrollTo(100);
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBe(100);
    // Reconnection refetches the authoritative messages through TanStack Query.
    count += 1;
    await page.context().setOffline(true);
    await page.context().setOffline(false);
    await expect(page.locator(".timeline-message")).toHaveCount(count);
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBe(100);
    await scrollTo("bottom");
    await expect.poll(bottomGap).toBeLessThan(2);
    count += 1;
    await page.context().setOffline(true);
    await page.context().setOffline(false);
    await expect(page.locator(".timeline-message")).toHaveCount(count);
    await expect.poll(bottomGap).toBeLessThan(2);
  });
}
