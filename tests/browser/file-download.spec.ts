import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { registerAndCreateProject } from "./browser-fixture";

test("downloads the displayed UTF-8 file without another sandbox read", async ({ page }) => {
  const content = "你好，工作区\nconst value = '<script>not executed</script>';\n";
  let reads = 0;
  await page.route("**/api/projects/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET" && /^\/api\/projects\/[^/]+$/u.test(path)) {
      const response = await route.fetch();
      const project = await response.json();
      project.sandboxLease = {
        id: "lease-public",
        runtimeId: "e2b",
        status: "idle",
        updatedAt: "2026-09-20T00:00:00.000Z",
      };
      return route.fulfill({ response, json: project });
    }
    if (path.endsWith("/files/content")) {
      reads += 1;
      return route.fulfill({
        json: {
          content,
          name: "notes.txt",
          path: "notes.txt",
          size: Buffer.byteLength(content),
          modifiedAt: null,
        },
      });
    }
    if (path.endsWith("/files"))
      return route.fulfill({
        json: {
          entries: [
            {
              kind: "file",
              name: "notes.txt",
              path: "notes.txt",
              size: Buffer.byteLength(content),
              modifiedAt: null,
            },
          ],
          path: "",
          truncated: false,
        },
      });
    return route.continue();
  });
  await registerAndCreateProject(page, "download");
  await page.getByRole("button", { name: "Open project inspector" }).click();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: /notes.txt/ }).click();
  await expect(page.locator(".project-file-content")).toHaveText(content);
  await expect(
    page.getByText("Download saves the displayed text file only. It is not a project backup."),
  ).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download displayed file" }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("notes.txt");
  const path = await download.path();
  expect(path).not.toBeNull();
  expect(await readFile(path as string, "utf8")).toBe(content);
  expect(reads).toBe(1);
});
