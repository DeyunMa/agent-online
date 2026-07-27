import { defineConfig, devices } from "@playwright/test";

const baseURL = requireHttpsOrigin("PREVIEW_E2E_BASE_URL");
requireEnvironmentVariable("PREVIEW_E2E_EMAIL");
requireEnvironmentVariable("PREVIEW_E2E_PASSWORD");

export default defineConfig({
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  outputDir: "output/playwright/preview-results",
  projects: [
    {
      name: "preview-chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
  reporter: [["list"]],
  testDir: "tests/preview",
  timeout: 300_000,
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  workers: 1,
});

function requireEnvironmentVariable(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the hosted Preview E2E`);
  }
  return value;
}

function requireHttpsOrigin(name: string) {
  const value = requireEnvironmentVariable(name);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value) {
    throw new Error(`${name} must be an HTTPS origin without a path`);
  }
  return value;
}
