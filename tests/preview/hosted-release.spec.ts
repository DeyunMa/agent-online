import { expect, type Page, type Response, test } from "@playwright/test";

const email = process.env.PREVIEW_E2E_EMAIL as string;
const password = process.env.PREVIEW_E2E_PASSWORD as string;

test.afterEach(async ({ page }) => {
  try {
    const cancel = page.getByRole("button", { name: "Cancel run" });
    if (await cancel.isVisible({ timeout: 1_000 })) {
      await cancel.click();
      await expect(cancel).toHaveCount(0, { timeout: 30_000 });
    }

    const openInspector = page.getByRole("button", { name: "Open project inspector" });
    if (await openInspector.isVisible({ timeout: 1_000 })) {
      await openInspector.click();
    }

    const terminalTab = page.getByRole("tab", { name: "Terminal" });
    if (await terminalTab.isVisible({ timeout: 1_000 })) {
      await terminalTab.click();
      const closeTerminal = page.getByRole("button", { name: "Close terminal" });
      if (await closeTerminal.isVisible({ timeout: 1_000 })) {
        await closeTerminal.click();
        await page.getByText("Closed", { exact: true }).waitFor({ timeout: 30_000 });
      }
    }

    const previewTab = page.getByRole("tab", { name: "Preview" });
    if (await previewTab.isVisible({ timeout: 1_000 })) {
      await previewTab.click();
      const stopPreview = page
        .locator(".project-preview-view")
        .getByRole("button", { exact: true, name: "Stop" });
      if (await stopPreview.isVisible({ timeout: 1_000 })) {
        await stopPreview.click();
        await page
          .locator(".project-preview-view")
          .getByText("Stopped", { exact: true })
          .waitFor({ timeout: 30_000 });
      }
    }

    const overview = page.getByRole("tab", { name: "Overview" });
    if (await overview.isVisible({ timeout: 1_000 })) {
      await overview.click();
    }
    const stopSandbox = page.getByRole("button", { name: "Stop sandbox" });
    if ((await stopSandbox.isVisible({ timeout: 1_000 })) && (await stopSandbox.isEnabled())) {
      await stopSandbox.click();
    }
  } catch {
    // The provider timeout remains the cleanup bound when the product path itself is unavailable.
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("runs the hosted Pi/Goose product path without exposing provider state", async ({ page }) => {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const projectName = `release-smoke-${suffix}`;
  const fileName = `release-smoke-${suffix}.txt`;
  const uploadedFileName = `uploaded-${suffix}.txt`;
  const marker = `agent-online-release-${suffix}`;
  const uploadedMarker = `browser-upload-${suffix}`;
  const apiResponseAuditErrors: unknown[] = [];

  const finishPrivateStateAudit = installPrivateStateAudit(page, apiResponseAuditErrors);

  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("link", { name: "New project" }).first().click();
  await page.getByLabel("Project name").fill(projectName);
  await page.getByRole("button", { name: "Create project" }).click();

  await expect(page.getByLabel("Agent task")).toBeVisible();
  const agentRuntime = page.getByLabel("Agent runtime");
  await expect(agentRuntime).toHaveText("Pi");
  await agentRuntime.click();
  await expect(page.getByRole("menu", { name: "Agent runtime options" })).toBeVisible();
  await page.getByRole("menuitemradio", { name: "Pi" }).press("Escape");
  await page
    .getByLabel("Agent task")
    .fill(
      `Create /workspace/${fileName} with the exact text ${marker}. ` +
        `Then reply with the exact marker ${marker}. Do not modify any other file.`,
    );
  await page.getByRole("button", { name: "Start run" }).click();

  await expect(
    page.getByRole("list", { name: "Project conversation" }).getByText(marker, { exact: false }),
  ).toBeVisible({ timeout: 180_000 });

  await page.getByRole("tab", { name: "Runs" }).click();
  const selectedRunSummary = page.getByRole("region", { name: "Selected run summary" });
  await expect(selectedRunSummary.getByText("执行完成", { exact: true })).toBeVisible();
  const selectedRunMetrics = page.getByLabel("Selected run metrics");
  const totalTokens = selectedRunMetrics.locator("div").filter({ hasText: "Total tokens" });
  const modelRequests = selectedRunMetrics.locator("div").filter({ hasText: "Model requests" });
  await expect(totalTokens.locator("dd")).toHaveText(/^(?!0$|—$).+/);
  await expect(modelRequests.locator("dd")).toHaveText(/^[1-9]\d*$/);
  await page.getByRole("tab", { name: "Conversation" }).click();

  const projectInspector = page.getByRole("complementary", { name: "Project inspector" });
  await page.getByLabel("Choose file to upload").setInputFiles({
    buffer: Buffer.from(uploadedMarker),
    mimeType: "text/plain",
    name: uploadedFileName,
  });
  await expect(
    projectInspector.locator(".project-file-row").filter({ hasText: uploadedFileName }),
  ).toBeVisible();
  await projectInspector.locator(".project-file-row").filter({ hasText: uploadedFileName }).click();
  await expect(projectInspector.locator(".project-file-content")).toHaveText(uploadedMarker);
  await projectInspector.locator(".project-file-back").click();
  await projectInspector.locator(".project-file-row").filter({ hasText: fileName }).click();
  await expect(projectInspector.locator(".project-file-content")).toHaveText(marker);

  const assistantMessagesBeforeCancel = await page.locator(".timeline-message-assistant").count();
  await agentRuntime.click();
  await page.getByRole("menuitemradio", { name: "Goose" }).click();
  await page
    .getByLabel("Agent task")
    .fill("Run the shell command `sleep 120`, wait for it to finish, and only then reply.");
  await page.getByRole("button", { name: "Start run" }).click();
  const currentRunStatus = page.getByRole("region", { name: "Current run status" });
  await expect(currentRunStatus.getByText("正在执行", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Cancel run" }).click();
  await expect(currentRunStatus).toHaveCount(0, {
    timeout: 60_000,
  });
  await page.getByRole("tab", { name: "Runs" }).click();
  await expect(
    page.getByRole("region", { name: "Selected run summary" }).getByText("已取消", { exact: true }),
  ).toBeVisible();

  await page.reload();
  await expect(page.getByRole("region", { name: "Current run status" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Runs" }).click();
  await expect(
    page.getByRole("region", { name: "Selected run summary" }).getByText("已取消", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Agent runtime")).toHaveText("Pi");
  await expect(page.locator(".timeline-message-assistant")).toHaveCount(
    assistantMessagesBeforeCancel,
  );

  await page.getByRole("button", { name: "Open project inspector" }).click();
  await page.getByRole("tab", { name: "Overview" }).click();
  await page.getByRole("button", { name: "Stop sandbox" }).click();
  await expect(page.locator(".project-inspector").getByText("已停止", { exact: true })).toBeVisible(
    {
      timeout: 60_000,
    },
  );

  await finishPrivateStateAudit();
  if (apiResponseAuditErrors.length > 0) {
    throw apiResponseAuditErrors[0];
  }
});

test("renames and hard-deletes a Project with an idle hosted sandbox", async ({ page }) => {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const projectName = `lifecycle-e2e-${suffix}`;
  const renamedProject = `${projectName}-renamed`;
  const apiResponseAuditErrors: unknown[] = [];

  const finishPrivateStateAudit = installPrivateStateAudit(page, apiResponseAuditErrors);
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("link", { name: "New project" }).first().click();
  await page.getByLabel("Project name").fill(projectName);
  await page.getByRole("button", { name: "Create project" }).click();
  const projectId = new URL(page.url()).pathname.split("/").at(-1);
  if (!projectId) {
    throw new Error("Created Project URL did not contain a Project ID");
  }

  const projectInspector = page.getByRole("complementary", { name: "Project inspector" });
  await page.getByRole("button", { name: "Open project inspector" }).click();
  await page.getByRole("tab", { name: "Terminal" }).click();
  await projectInspector.getByRole("button", { exact: true, name: "Connect" }).click();
  await expect(projectInspector.getByText("Connected", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await projectInspector.getByRole("button", { name: "Close terminal" }).click();
  await expect(projectInspector.getByText("Closed", { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  const projectHeaderActions = page.locator(".project-console-header-actions");
  await projectHeaderActions
    .getByRole("button", { name: `Project actions for ${projectName}` })
    .click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename project" });
  await renameDialog.getByLabel("Project name").fill(renamedProject);
  await renameDialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("link", { exact: true, name: renamedProject })).toBeVisible();

  await projectHeaderActions
    .getByRole("button", { name: `Project actions for ${renamedProject}` })
    .click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete project" });
  await expect(deleteDialog).toContainText("permanently removed");
  await deleteDialog.getByRole("button", { name: "Delete project" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole("link", { exact: true, name: renamedProject })).toHaveCount(0);
  const deletedProjectStatus = await page.evaluate(
    async (id) => (await fetch(`/api/projects/${encodeURIComponent(id)}`)).status,
    projectId,
  );
  expect(deletedProjectStatus).toBe(404);

  await finishPrivateStateAudit();
  if (apiResponseAuditErrors.length > 0) {
    throw apiResponseAuditErrors[0];
  }
});

test("runs Files, Changes, Terminal, and Preview in one hosted sandbox", async ({ page }) => {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const projectName = `capabilities-e2e-${suffix}`;
  const previewMarker = `preview-marker-${suffix}`;
  const terminalMarker = `terminal-marker-${suffix}`;
  const terminalFile = `terminal-${suffix}.txt`;
  const fixtureReady = `fixture-ready-${suffix}`;
  const fixtureReadyBase64 = Buffer.from(fixtureReady).toString("base64");
  const apiResponseAuditErrors: unknown[] = [];

  const finishPrivateStateAudit = installPrivateStateAudit(page, apiResponseAuditErrors);

  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("link", { name: "New project" }).first().click();
  await page.getByLabel("Project name").fill(projectName);
  await page.getByRole("button", { name: "Create project" }).click();

  const projectInspector = page.getByRole("complementary", { name: "Project inspector" });
  await page.getByRole("button", { name: "Open project inspector" }).click();
  await page.getByRole("tab", { name: "Terminal" }).click();
  await projectInspector.getByRole("button", { exact: true, name: "Connect" }).click();
  await expect(projectInspector.getByText("Connected", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await projectInspector.getByRole("button", { name: "Close terminal" }).click();
  await expect(projectInspector.getByText("Closed", { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  await page.getByRole("tab", { name: "Preview" }).click();
  await projectInspector.getByRole("button", { exact: true, name: "Start" }).click();
  await expect(
    projectInspector.getByText("当前项目没有可预览的 Web 入口，请先创建 /workspace/index.html。", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 30_000 });

  await page.getByRole("tab", { name: "Terminal" }).click();
  await projectInspector.getByRole("button", { exact: true, name: "Connect" }).click();
  await expect(projectInspector.getByText("Connected", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const fixtureCommand = [
    "mkdir -p src",
    `printf %s ${shellQuote('<div id="app"></div><script type="module" src="/src/main.js"></script>')} > index.html`,
    `printf %s ${shellQuote("document.querySelector('#app').textContent = 'baseline';")} > src/main.js`,
    "git init -q /workspace",
    "git -C /workspace add index.html src/main.js",
    "git -C /workspace -c user.email=e2e@agent-online.test -c user.name=Agent-Online-E2E commit -qm baseline",
    `printf %s ${shellQuote(`document.querySelector('#app').textContent = '${previewMarker}';`)} > src/main.js`,
    `printf %s ${shellQuote("hosted capability fixture")} > E2E-NOTES.txt`,
    `printf %s ${shellQuote(fixtureReadyBase64)} | base64 -d`,
  ].join(" && ");
  await projectInspector.locator(".project-terminal-canvas").click();
  await page.keyboard.type(fixtureCommand);
  await page.keyboard.press("Enter");
  await expect(projectInspector.locator(".xterm-rows")).toContainText(fixtureReady, {
    timeout: 120_000,
  });
  await projectInspector.getByRole("button", { name: "Close terminal" }).click();
  await expect(projectInspector.getByText("Closed", { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  await page.getByRole("tab", { name: "Changes" }).click();
  await expect(
    projectInspector.locator(".project-change-row").filter({ hasText: "src/main.js" }),
  ).toBeVisible();
  await expect(
    projectInspector.locator(".project-change-row").filter({ hasText: "E2E-NOTES.txt" }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Terminal" }).click();
  await projectInspector.getByRole("button", { exact: true, name: "Connect" }).click();
  await expect(projectInspector.getByText("Connected", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await projectInspector.locator(".project-terminal-canvas").click();
  await page.keyboard.type(`printf %s ${terminalMarker} > ${terminalFile} && cat ${terminalFile}`);
  await page.keyboard.press("Enter");
  await expect(projectInspector.locator(".xterm-rows")).toContainText(terminalMarker, {
    timeout: 30_000,
  });
  await projectInspector.getByRole("button", { name: "Close terminal" }).click();
  await expect(projectInspector.getByText("Closed", { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  await page.getByRole("tab", { name: "Files" }).click();
  await projectInspector.locator(".project-file-row").filter({ hasText: terminalFile }).click();
  await expect(projectInspector.locator(".project-file-content")).toHaveText(terminalMarker);

  await page.getByRole("tab", { name: "Preview" }).click();
  await projectInspector.getByRole("button", { exact: true, name: "Start" }).click();
  await expect(projectInspector.getByText("Running", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.frameLocator('iframe[title="Project preview"]').getByText(previewMarker, {
      exact: true,
    }),
  ).toBeVisible({ timeout: 30_000 });
  await projectInspector.getByRole("button", { exact: true, name: "Stop" }).click();
  await expect(projectInspector.getByText("Stopped", { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  await page.getByRole("tab", { name: "Changes" }).click();
  await projectInspector.locator(".project-change-row").filter({ hasText: "src/main.js" }).click();
  await expect(projectInspector.locator(".project-change-diff")).toContainText(previewMarker);

  await page.getByRole("tab", { name: "Overview" }).click();
  await page.getByRole("button", { name: "Stop sandbox" }).click();
  await expect(page.locator(".project-inspector").getByText("已停止", { exact: true })).toBeVisible(
    {
      timeout: 60_000,
    },
  );

  await finishPrivateStateAudit();
  if (apiResponseAuditErrors.length > 0) {
    throw apiResponseAuditErrors[0];
  }
});

function installPrivateStateAudit(page: Page, errors: unknown[]) {
  const pendingAudits = new Set<Promise<void>>();
  const auditResponse = (response: Response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/") || url.pathname.endsWith("/events")) {
      return;
    }

    const audit = auditPrivateJsonResponse(response, errors);
    pendingAudits.add(audit);
    void audit.finally(() => pendingAudits.delete(audit));
  };

  page.on("response", auditResponse);
  return async () => {
    page.off("response", auditResponse);
    await Promise.all(pendingAudits);
  };
}

async function auditPrivateJsonResponse(response: Response, errors: unknown[]) {
  if (response.headers()["content-type"]?.includes("application/json")) {
    try {
      const body = await response.body();
      const request = response.request();
      try {
        expect(
          body.toString("utf8"),
          `${request.method()} ${new URL(response.url()).pathname}`,
        ).not.toMatch(
          /provider(?:_|)(?:ref|processRef|sandboxRef)|trafficAccessToken|GEMINI_API_KEY|E2B_API_KEY|AIza[A-Za-z0-9_-]{20,}/i,
        );
      } catch (error) {
        errors.push(error);
      }
    } catch {
      // A navigation may cancel an in-flight response after headers arrive.
    }
  }
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
