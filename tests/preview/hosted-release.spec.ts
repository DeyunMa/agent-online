import { expect, test, type Response as PlaywrightResponse } from "@playwright/test";

const email = process.env.PREVIEW_E2E_EMAIL as string;
const password = process.env.PREVIEW_E2E_PASSWORD as string;

test.afterEach(async ({ page }) => {
  try {
    const cancel = page.getByRole("button", { name: "Cancel run" });
    if (await cancel.isVisible({ timeout: 1_000 })) {
      await cancel.click();
      await page
        .getByRole("region", { name: "Current run status" })
        .getByText(/^(已取消|执行失败|执行中断|执行超时)$/u)
        .waitFor({ timeout: 30_000 });
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
  }
});

test("runs the hosted Pi product path without exposing provider state", async ({ page }) => {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const projectName = `release-smoke-${suffix}`;
  const fileName = `release-smoke-${suffix}.txt`;
  const marker = `agent-online-release-${suffix}`;
  const apiResponseAudits: Promise<void>[] = [];
  const apiResponseAuditErrors: unknown[] = [];

  page.on("response", (response) => {
    if (isJsonApiResponse(response)) {
      apiResponseAudits.push(
        assertNoPrivateProviderState(response).catch((error) => {
          apiResponseAuditErrors.push(error);
        }),
      );
    }
  });

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
  await page
    .getByLabel("Agent task")
    .fill(
      `Create /workspace/${fileName} with the exact text ${marker}. ` +
        `Then reply with the exact marker ${marker}. Do not modify any other file.`,
    );
  await page.getByRole("button", { name: "Start run" }).click();

  const currentRunStatus = page.getByRole("region", { name: "Current run status" });
  await expect(currentRunStatus.getByText("执行完成", { exact: true })).toBeVisible({
    timeout: 180_000,
  });
  await expect(
    page.getByRole("list", { name: "Project conversation" }).getByText(marker, { exact: false }),
  ).toBeVisible();

  const totalTokens = page.locator(".run-metrics > div").filter({ hasText: "Total tokens" });
  const modelRequests = page.locator(".run-metrics > div").filter({ hasText: "Model requests" });
  await expect(totalTokens.locator("dd")).toHaveText(/^(?!0$|—$).+/);
  await expect(modelRequests.locator("dd")).toHaveText(/^[1-9]\d*$/);

  await page.getByRole("tab", { name: "Files" }).click();
  await page.getByRole("button", { name: fileName }).click();
  await expect(page.locator(".project-file-content")).toHaveText(marker);

  const assistantMessagesBeforeCancel = await page.locator(".timeline-message-assistant").count();
  await page
    .getByLabel("Agent task")
    .fill("Run the shell command `sleep 120`, wait for it to finish, and only then reply.");
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(currentRunStatus.getByText("正在执行", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Cancel run" }).click();
  await expect(currentRunStatus.getByText("已取消", { exact: true })).toBeVisible({
    timeout: 60_000,
  });

  await page.reload();
  await expect(currentRunStatus.getByText("已取消", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator(".timeline-message-assistant")).toHaveCount(
    assistantMessagesBeforeCancel,
  );

  await page.getByRole("tab", { name: "Overview" }).click();
  await page.getByRole("button", { name: "Stop sandbox" }).click();
  await expect(page.locator(".project-inspector").getByText("已停止", { exact: true })).toBeVisible(
    {
      timeout: 60_000,
    },
  );

  await Promise.all(apiResponseAudits);
  if (apiResponseAuditErrors.length > 0) {
    throw apiResponseAuditErrors[0];
  }
});

function isJsonApiResponse(response: PlaywrightResponse) {
  const url = new URL(response.url());
  return (
    url.pathname.startsWith("/api/") &&
    response.headers()["content-type"]?.includes("application/json") === true
  );
}

async function assertNoPrivateProviderState(response: PlaywrightResponse) {
  const body = await response.text();
  expect(body, `${response.request().method()} ${response.url()}`).not.toMatch(
    /provider(?:_|)(?:ref|processRef|sandboxRef)|trafficAccessToken|GEMINI_API_KEY|E2B_API_KEY|AIza[A-Za-z0-9_-]{20,}/i,
  );
}
