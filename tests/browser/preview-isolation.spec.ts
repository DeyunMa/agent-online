import { expect, test } from "@playwright/test";

import { previewContentCsp } from "../../src/server/preview-content-policy";

const contentPath = "/api/projects/preview-test/preview/content/test-capability/";
const probeHtml = `<!doctype html><html><head>
<link rel="stylesheet" href="${contentPath}style.css">
</head><body><div id="result">Loading</div>
<script>
  for (const [name, probe] of Object.entries({
    storage: () => localStorage.getItem("platform-state"),
    cookie: () => document.cookie,
    parent: () => { if (parent !== window) return parent.document.title; throw new Error(); },
  })) {
    try { probe(); document.body.dataset[name] = "accessible"; }
    catch { document.body.dataset[name] = "blocked"; }
  }
</script>
<script type="module" src="${contentPath}main.js"></script>
</body></html>`;

for (const mode of ["direct", "iframe"] as const) {
  test(`Preview isolates ${mode} documents while loading modules and styles`, async ({ page }) => {
    // Apply the production policy to deterministic Provider content. This does not
    // require a paid sandbox; API unit tests verify that the gateway emits it.
    await page.route(`**${contentPath}**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      const asset = path.endsWith("main.js")
        ? {
            body: `document.querySelector("#result").textContent = "Preview ready";`,
            type: "text/javascript",
          }
        : path.endsWith("style.css")
          ? { body: "#result { color: rgb(12, 34, 56); }", type: "text/css" }
          : { body: probeHtml, type: "text/html" };
      await route.fulfill({
        body: asset.body,
        headers: {
          "access-control-allow-origin": "*",
          "content-security-policy": previewContentCsp,
          "content-type": asset.type,
        },
      });
    });
    await page.route("**/preview-isolation-host", (route) =>
      route.fulfill({
        body: "<!doctype html><html><head><title>Platform</title></head><body></body></html>",
        contentType: "text/html",
      }),
    );
    await page.goto("/preview-isolation-host");
    await page.evaluate(() => localStorage.setItem("platform-state", "private-platform-state"));
    await page
      .context()
      .addCookies([{ name: "platform-cookie", value: "private", url: page.url() }]);

    if (mode === "direct") {
      await page.goto(contentPath);
    } else {
      await page.evaluate((src) => {
        const frame = document.createElement("iframe");
        frame.sandbox.add("allow-scripts");
        frame.src = src;
        document.body.appendChild(frame);
      }, contentPath);
    }
    const previewDocument = mode === "direct" ? page : page.frameLocator("iframe");
    await expect(previewDocument.locator("#result")).toHaveText("Preview ready");
    await expect(previewDocument.locator("#result")).toHaveCSS("color", "rgb(12, 34, 56)");
    await expect(previewDocument.locator("body")).toHaveAttribute("data-storage", "blocked");
    await expect(previewDocument.locator("body")).toHaveAttribute("data-cookie", "blocked");
    if (mode === "iframe") {
      await expect(previewDocument.locator("body")).toHaveAttribute("data-parent", "blocked");
    }
    await page.goto("/preview-isolation-host");
    expect(await page.evaluate(() => localStorage.getItem("platform-state"))).toBe(
      "private-platform-state",
    );
  });
}
