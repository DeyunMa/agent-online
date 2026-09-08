import { expect, test } from "@playwright/test";

import { registerAndCreateProject } from "./browser-fixture";

test("defers Project and Usage code until authenticated navigation", async ({ page }) => {
  const moduleRequests: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => {
    // Browser smoke runs Vite source modules; production chunk sizes are measured by build.
    if (/\/(project-console|usage-page)\.tsx(?:\?|$)/u.test(request.url())) {
      moduleRequests.push(request.url());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/projects/not-opened-yet");
  await expect(page.getByLabel("Email")).toBeVisible();
  expect(moduleRequests).toEqual([]);

  const { projectName } = await registerAndCreateProject(page, "browser-lazy");
  await expect(page.getByLabel("Agent task")).toBeVisible();
  expect(moduleRequests.some((url) => url.includes("/project-console.tsx"))).toBe(true);
  expect(moduleRequests.some((url) => url.includes("/usage-page.tsx"))).toBe(false);

  const accountMenuTrigger = page
    .locator(".project-sidebar")
    .getByRole("button", { name: "Open account menu" });
  await accountMenuTrigger.focus();
  await accountMenuTrigger.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Usage", exact: true })).toBeFocused();
  await page.getByRole("menuitem", { name: "Usage", exact: true }).press("End");
  await expect(page.getByRole("menuitem", { name: "Sign out", exact: true })).toBeFocused();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).press("Escape");
  await expect(accountMenuTrigger).toBeFocused();
  await accountMenuTrigger.click();
  await page.getByRole("menuitem", { name: "Usage", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  expect(moduleRequests.some((url) => url.includes("/usage-page.tsx"))).toBe(true);

  await page.getByRole("link", { name: projectName, exact: true }).click();
  await expect(page.getByLabel("Agent task")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Agent task")).toBeVisible();
  expect(errors).toEqual([]);
});
