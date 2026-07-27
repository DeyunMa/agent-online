import { expect, test } from "@playwright/test";

test("persists an authenticated Project and cancelled Run across reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Register" }).click();
  await page.getByLabel("Display name").fill("Browser Smoke");
  await page.getByLabel("Email").fill("browser-smoke@example.com");
  await page.getByLabel("Password").fill("browser-smoke-password");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
  await page.getByRole("link", { name: "New project" }).first().click();
  await page.getByLabel("Project name").fill("browser-smoke-project");
  await page.getByRole("button", { name: "Create project" }).click();

  await expect(page.getByLabel("Agent task")).toBeVisible();
  await page.getByLabel("Agent task").fill("Browser smoke task");
  await page.getByRole("button", { name: "Start run" }).click();
  await page.getByRole("button", { name: "Cancel run" }).click();
  const currentRunStatus = page.getByRole("region", { name: "Current run status" });
  await expect(currentRunStatus.getByText("已取消", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  await page.reload();
  await expect(
    page.getByRole("link", { exact: true, name: "browser-smoke-project" }),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Project conversation" }).getByText("Browser smoke task"),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Current run status" }).getByText("已取消", { exact: true }),
  ).toBeVisible();
});
