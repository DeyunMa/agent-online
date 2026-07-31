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
  await expect(page.getByRole("heading", { name: "Run history" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Runs" }).click();
  await expect(page.getByRole("heading", { name: "Run history" })).toBeVisible();
});

test("selects an advertised Agent runtime for the next Run", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({
      body: JSON.stringify({
        agentRuntimeIds: ["pi", "goose"],
        changesEnabled: false,
        defaultAgentRuntimeId: "pi",
        fileUploadEnabled: false,
        previewEnabled: false,
        runCreationEnabled: true,
        terminalEnabled: false,
      }),
      contentType: "application/json",
      status: 200,
    }),
  );
  await registerAndCreateProject(page, "browser-runtime");

  const runtime = page.getByLabel("Agent runtime");
  await expect(runtime).toBeEnabled();
  await expect(runtime).toHaveValue("pi");
  await runtime.selectOption("goose");
  await expect(runtime).toHaveValue("goose");

  await page.getByLabel("Agent task").fill("Use the selected runtime");
  const requestPromise = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith("/agent-runs"),
  );
  await page.getByRole("button", { name: "Start run" }).click();
  const request = await requestPromise;

  expect(request.postDataJSON()).toEqual({
    agentRuntimeId: "goose",
    content: "Use the selected runtime",
  });
  await expect(page.getByText("所选 Agent 当前不可用，请选择其他 Agent。")).toBeVisible();
});

test("uploads one file and opens the Files, Terminal, and Changes inspector views", async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({
      body: JSON.stringify({
        agentRuntimeIds: ["pi", "goose"],
        changesEnabled: true,
        defaultAgentRuntimeId: "pi",
        fileUploadEnabled: true,
        previewEnabled: true,
        runCreationEnabled: true,
        terminalEnabled: true,
      }),
      contentType: "application/json",
      status: 200,
    }),
  );
  await page.route("**/api/projects/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && /\/api\/projects\/[^/]+\/files$/u.test(path)) {
      await route.fulfill({
        body: JSON.stringify({
          name: "notes.txt",
          path: "notes.txt",
          size: 13,
        }),
        contentType: "application/json",
        status: 201,
      });
      return;
    }
    if (request.method() === "GET" && /^\/api\/projects\/[^/]+$/u.test(path)) {
      const response = await route.fetch();
      const project = (await response.json()) as Record<string, unknown>;
      project.sandboxLease = {
        id: "lease-public",
        runtimeId: "e2b",
        status: "idle",
        updatedAt: "2026-07-30T00:00:00.000Z",
      };
      await route.fulfill({ json: project, response });
      return;
    }
    await route.continue();
  });
  await registerAndCreateProject(page, "browser-tools");

  const inspector = page.getByRole("dialog", { name: "Project inspector" });
  const assertViewOpens = async (buttonName: string, tabName: string) => {
    await page.getByRole("button", { name: buttonName }).click();
    await expect(inspector).toBeVisible();
    await expect(
      inspector.getByRole("tablist", { name: "Project inspector views" }).getByRole("tab", {
        name: tabName,
      }),
    ).toHaveAttribute("aria-selected", "true");
    await inspector.getByRole("button", { name: "Close project inspector" }).click();
    await expect(inspector).toBeHidden();
  };

  await assertViewOpens("Open files", "Files");
  await assertViewOpens("Open terminal", "Terminal");
  await assertViewOpens("Open changes", "Changes");

  const uploadRequest = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith("/files"),
  );
  await page.getByLabel("Choose file to upload").setInputFiles({
    buffer: Buffer.from("upload marker"),
    mimeType: "text/plain",
    name: "notes.txt",
  });
  const request = await uploadRequest;

  expect(await request.headerValue("content-type")).toContain("multipart/form-data");
  expect(request.postDataBuffer()?.toString()).toContain("upload marker");
  expect(request.postDataBuffer()?.toString()).toContain('filename="notes.txt"');
  await expect(inspector).toBeVisible();
  await expect(
    inspector.getByRole("tablist", { name: "Project inspector views" }).getByRole("tab", {
      name: "Files",
    }),
  ).toHaveAttribute("aria-selected", "true");
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

test("opens and resizes the Project inspector drawer without shrinking the core area", async ({
  page,
}) => {
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
  await expect(inspector).toBeHidden();
  await expect(separator).toBeHidden();

  const sidebarBefore = await requiredBox(sidebar);
  const mainBefore = await requiredBox(consoleMain);
  expect(sidebarBefore.width).toBeCloseTo(240, 1);

  await page.getByRole("button", { name: "Open project inspector" }).click();
  await expect(inspector).toBeVisible();
  await expect(separator).toBeVisible();

  const projectRunTabsBox = await requiredBox(projectRunTabs);
  const runStatusBarBox = await requiredBox(runStatusBar);
  const inspectorHeaderBox = await requiredBox(inspectorHeader);
  const inspectorTabsBox = await requiredBox(inspectorTabs);
  expect(bottom(projectRunTabsBox)).toBeCloseTo(bottom(inspectorHeaderBox), 1);
  expect(bottom(runStatusBarBox)).toBeCloseTo(bottom(inspectorTabsBox), 1);

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
  expect(Math.abs(mainAfter.width - mainBefore.width)).toBeLessThan(1);

  await page.reload();
  await expect(inspector).toBeHidden();
  await expect(separator).toBeHidden();
  await page.getByRole("button", { name: "Open project inspector" }).click();
  const inspectorReloaded = await requiredBox(inspector);
  expect(Math.abs(inspectorReloaded.width - inspectorAfter.width)).toBeLessThan(2);

  await separator.focus();
  await separator.press("ArrowRight");
  const inspectorAfterKeyboard = await requiredBox(inspector);
  expect(inspectorAfterKeyboard.width).toBeLessThan(inspectorReloaded.width);

  await page.getByRole("button", { name: "Close project inspector" }).click();
  await expect(inspector).toBeHidden();
  await expect(separator).toBeHidden();
  const mainClosed = await requiredBox(consoleMain);
  expect(Math.abs(mainClosed.width - mainBefore.width)).toBeLessThan(1);

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(sidebar).toBeHidden();
  await page.getByRole("button", { name: "Open project inspector" }).click();
  await expect(page.getByRole("dialog", { name: "Project inspector" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dismiss project inspector" })).toBeVisible();
  await expect(separator).toBeHidden();
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
