import { expect, test } from "@playwright/test";

import { registerAndCreateProject } from "./browser-fixture";

test("persists a cancelled Run and rejects deletion while the Project is active", async ({
  page,
}) => {
  const { projectName } = await registerAndCreateProject(page, "browser-run");
  await page.getByLabel("Agent task").fill("Browser smoke task");
  await page.getByRole("button", { name: "Start run" }).click();

  const projectHeaderActions = page.locator(".project-console-header-actions");
  const projectActions = projectHeaderActions.getByRole("button", {
    name: `Project actions for ${projectName}`,
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
  await expect(page.getByRole("link", { exact: true, name: projectName })).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Project conversation" }).getByText("Browser smoke task"),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Current run status" }).getByText("已取消", { exact: true }),
  ).toBeVisible();
});

test("renames and hard-deletes a Project from the mobile layout", async ({ page }) => {
  const { projectName } = await registerAndCreateProject(page, "browser-lifecycle");
  const renamedProject = `${projectName}-renamed`;
  const projectHeaderActions = page.locator(".project-console-header-actions");
  await projectHeaderActions
    .getByRole("button", { name: `Project actions for ${projectName}` })
    .click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename project" });
  await expect(renameDialog.getByRole("button", { name: "Save" })).toBeDisabled();
  await renameDialog.getByLabel("Project name").fill(renamedProject);
  await renameDialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("link", { exact: true, name: renamedProject })).toBeVisible();

  await page.setViewportSize({ height: 844, width: 390 });
  await page.getByRole("button", { name: "Open project inspector" }).click();
  const inspectorTabs = page.getByRole("tablist", { name: "Project inspector views" });
  const overviewTab = inspectorTabs.getByRole("tab", { name: "Overview" });
  const filesTab = inspectorTabs.getByRole("tab", { name: "Files" });
  await overviewTab.focus();
  await overviewTab.press("ArrowRight");
  await expect(filesTab).toBeFocused();
  await expect(filesTab).toHaveAttribute("aria-selected", "true");
  await filesTab.press("Home");
  await expect(overviewTab).toBeFocused();
  await projectHeaderActions
    .getByRole("button", { name: `Project actions for ${renamedProject}` })
    .click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete project" });
  await expect(deleteDialog).toBeInViewport({ ratio: 1 });
  await expect(deleteDialog).toContainText("usage recorded by those Runs");
  await deleteDialog.getByRole("button", { name: "Delete project" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
  await expect(page.getByRole("link", { exact: true, name: renamedProject })).toHaveCount(0);
});
