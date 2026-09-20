import { expect, test } from "@playwright/test";
import { registerAndCreateProject } from "./browser-fixture";

test("keeps a rejected task draft and explains user resource limits", async ({ page }) => {
  await registerAndCreateProject(page, "resource-limit");
  await page.route("**/api/projects/*/agent-runs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return route.fulfill({
      status: 429,
      json: { error: { code: "resource.limited", retryable: true }, requestId: "limit-test" },
    });
  });
  const task = page.getByLabel("Agent task");
  await task.fill("Please preserve this draft");
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(task).toHaveValue("Please preserve this draft");
  await expect(task).toBeEnabled();
  await expect(
    page
      .getByText("当前用户的并发或启动额度已用尽，请结束其他项目活动或稍后重试。", { exact: true })
      .first(),
  ).toBeVisible();
  await expect(page.locator(".timeline-message")).toHaveCount(0);
});
