import { expect, type Locator, test } from "@playwright/test";

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
  await expect(deleteDialog).toContainText("Aggregate Run usage remains");
  await deleteDialog.getByRole("button", { name: "Delete project" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
  await expect(page.getByRole("link", { exact: true, name: renamedProject })).toHaveCount(0);
});

test("resizes the Project inspector without changing the fixed sidebar", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1_440 });
  await registerAndCreateProject(page, "browser-resize");

  const sidebar = page.locator(".project-sidebar");
  const consoleMain = page.locator("#project-console-main");
  const inspector = page.locator("#project-inspector");
  const projectRunTabs = page.locator(".project-run-tabs");
  const runStatusBar = page.locator(".run-status-bar");
  const inspectorHeader = page.locator(".project-inspector-header");
  const inspectorTabs = page.locator(".inspector-tabs");
  const separator = page.getByRole("separator", {
    name: "Resize project inspector",
  });
  await expect(separator).toBeVisible();

  const projectRunTabsBox = await requiredBox(projectRunTabs);
  const runStatusBarBox = await requiredBox(runStatusBar);
  const inspectorHeaderBox = await requiredBox(inspectorHeader);
  const inspectorTabsBox = await requiredBox(inspectorTabs);
  expect(bottom(projectRunTabsBox)).toBeCloseTo(bottom(inspectorHeaderBox), 1);
  expect(bottom(runStatusBarBox)).toBeCloseTo(bottom(inspectorTabsBox), 1);

  const sidebarBefore = await requiredBox(sidebar);
  const mainBefore = await requiredBox(consoleMain);
  const inspectorBefore = await requiredBox(inspector);
  const separatorBox = await requiredBox(separator);

  await page.mouse.move(
    separatorBox.x + separatorBox.width / 2,
    separatorBox.y + separatorBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(separatorBox.x - 150, separatorBox.y + separatorBox.height / 2, {
    steps: 8,
  });
  await page.mouse.up();

  const sidebarAfter = await requiredBox(sidebar);
  const mainAfter = await requiredBox(consoleMain);
  const inspectorAfter = await requiredBox(inspector);
  expect(Math.abs(sidebarAfter.width - sidebarBefore.width)).toBeLessThan(1);
  expect(inspectorAfter.width).toBeGreaterThan(inspectorBefore.width + 120);
  expect(mainAfter.width).toBeLessThan(mainBefore.width - 120);

  await page.reload();
  const inspectorReloaded = await requiredBox(inspector);
  expect(Math.abs(inspectorReloaded.width - inspectorAfter.width)).toBeLessThan(2);

  await separator.focus();
  await separator.press("ArrowRight");
  const inspectorAfterKeyboard = await requiredBox(inspector);
  expect(inspectorAfterKeyboard.width).toBeLessThan(inspectorReloaded.width);

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(separator).toBeHidden();
  await expect(sidebar).toBeHidden();
  await expect(page.getByRole("button", { name: "Open project inspector" })).toBeVisible();
});

async function requiredBox(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("Expected element to have a bounding box");
  }
  return box;
}

function bottom(box: { height: number; y: number }) {
  return box.y + box.height;
}
