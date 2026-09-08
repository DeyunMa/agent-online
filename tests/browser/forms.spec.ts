import { expect, test } from "@playwright/test";

import { registerAndCreateProject } from "./browser-fixture";

test("validates authentication fields and supports keyboard mode changes", async ({ page }) => {
  let authRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/auth\/sign-(in|up)\/email/.test(request.url()))
      authRequests += 1;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Enter your email address.")).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Email")).toBeFocused();
  await page.getByLabel("Email").fill("invalid");
  await page.getByLabel("Password").fill("short");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Enter a valid email address.")).toBeVisible();
  await expect(page.getByText("Password must contain at least 8 characters.")).toBeVisible();
  expect(authRequests).toBe(0);

  const signInTab = page.getByRole("tab", { name: "Sign in", exact: true });
  await signInTab.focus();
  await signInTab.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Register" })).toBeFocused();
  await expect(page.getByLabel("Display name")).toBeVisible();
  await expect(page.getByText("Enter a valid email address.")).toBeHidden();
  await page.getByLabel("Email").fill("form-test@example.com");
  await page.getByLabel("Password").fill("browser-smoke-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Enter a display name.")).toBeVisible();
  expect(authRequests).toBe(0);
});

test("locks the auth mode during submission and safely displays service errors", async ({
  page,
}) => {
  let releaseRequest = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  let body: Record<string, unknown> | undefined;
  await page.route("**/api/auth/sign-in/email", async (route) => {
    body = route.request().postDataJSON();
    await gate;
    await route.fulfill({
      status: 401,
      json: { code: "INVALID_EMAIL_OR_PASSWORD", message: "private backend detail" },
    });
  });
  await page.goto("/");
  await page.getByLabel("Email").fill("  form-test@example.com  ");
  await page.getByLabel("Password").fill("browser-smoke-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  try {
    await expect(page.getByRole("button", { name: "Working" })).toBeDisabled();
    await expect(page.getByRole("tab", { name: "Register" })).toBeDisabled();
    await expect(page.getByLabel("Email")).toBeDisabled();
    await expect.poll(() => body?.email).toBe("form-test@example.com");
  } finally {
    releaseRequest();
  }
  await expect(page.getByText("Email or password is incorrect.")).toBeVisible();
  await expect(page.getByText("private backend detail")).toHaveCount(0);
  await page.getByRole("tab", { name: "Register" }).click();
  await expect(page.getByText("Email or password is incorrect.")).toBeHidden();
  await page.route("**/api/auth/sign-up/email", (route) =>
    route.fulfill({
      status: 403,
      json: { message: "This deployment is invite-only." },
    }),
  );
  await page.getByLabel("Display name").fill("Form Test");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("This deployment is invite-only.")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Sign in", exact: true })).toBeEnabled();
});

test("validates project creation, retains errors and navigates after a successful retry", async ({
  page,
}) => {
  await registerAndCreateProject(page, "browser-forms");
  await page.getByRole("link", { name: "New project" }).first().click();
  let createRequests = 0;
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    createRequests += 1;
    if (createRequests === 1) {
      await route.fulfill({ status: 503, body: "unavailable" });
    } else {
      expect(route.request().postDataJSON()).toEqual({ title: "Retry project" });
      await route.continue();
    }
  });
  await page.getByLabel("Project name").fill("   ");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByText("Enter a project name.")).toBeVisible();
  await expect(page.getByLabel("Project name")).toBeFocused();
  expect(createRequests).toBe(0);
  await page.getByLabel("Project name").fill("  Retry project  ");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("服务返回了无法识别的响应");
  await expect(page.getByLabel("Project name")).toHaveValue("  Retry project  ");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByLabel("Agent task")).toBeVisible();
  await expect(page.getByRole("link", { name: "Retry project", exact: true })).toBeVisible();
  expect(createRequests).toBe(2);
});
