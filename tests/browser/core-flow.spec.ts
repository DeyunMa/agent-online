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

  const projectHeaderActions = page.locator(".project-console-header-actions");
  const projectActions = projectHeaderActions.getByRole("button", {
    name: "Project actions for browser-smoke-project",
  });
  await projectActions.focus();
  await projectActions.press("Enter");
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page
    .getByRole("dialog", { name: "Delete project" })
    .getByRole("button", {
      name: "Delete project",
    })
    .click();
  await expect(page.getByText("该项目已有正在执行的任务。")).toBeVisible();
  await page
    .getByRole("dialog", { name: "Delete project" })
    .getByRole("button", {
      name: "Cancel",
    })
    .click();

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

  await projectHeaderActions
    .getByRole("button", { name: "Project actions for browser-smoke-project" })
    .click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename project" });
  await expect(renameDialog.getByRole("button", { name: "Save" })).toBeDisabled();
  await renameDialog.getByLabel("Project name").fill("browser-smoke-renamed");
  await renameDialog.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("link", { exact: true, name: "browser-smoke-renamed" }),
  ).toBeVisible();

  await page.setViewportSize({ height: 844, width: 390 });
  await page.getByRole("button", { name: "Open project inspector" }).click();
  await projectHeaderActions
    .getByRole("button", { name: "Project actions for browser-smoke-renamed" })
    .click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete project" });
  await expect(deleteDialog).toBeInViewport({ ratio: 1 });
  await expect(deleteDialog).toContainText("usage recorded by those Runs");
  await deleteDialog.getByRole("button", { name: "Delete project" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
  await expect(page.getByRole("link", { exact: true, name: "browser-smoke-renamed" })).toHaveCount(
    0,
  );
});
