import { expect, type Page } from "@playwright/test";

export async function registerAndCreateProject(page: Page, label: string) {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const projectName = `${label}-${suffix}`;

  await page.goto("/");
  await page.getByRole("tab", { name: "Register" }).click();
  await page.getByLabel("Display name").fill("Browser Smoke");
  await page.getByLabel("Email").fill(`${projectName}@example.com`);
  await page.getByLabel("Password").fill("browser-smoke-password");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
  await page.getByRole("link", { name: "New project" }).first().click();
  await page.getByLabel("Project name").fill(projectName);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByLabel("Agent task")).toBeVisible();

  return { projectName };
}
