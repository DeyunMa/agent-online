import { cloudflare } from "@cloudflare/vite-plugin";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import react from "@vitejs/plugin-react";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig(({ command, mode }) => {
  const browserSmoke = mode === "browser-smoke";
  const sentryUploadEnabled =
    command === "build" && process.env.SENTRY_UPLOAD_SOURCEMAPS === "true";
  const sentryCredentialsAvailable =
    Boolean(process.env.SENTRY_AUTH_TOKEN) ||
    existsSync(resolve(process.cwd(), ".env.sentry-build-plugin"));
  if (sentryUploadEnabled && !sentryCredentialsAvailable) {
    throw new Error(
      "SENTRY_UPLOAD_SOURCEMAPS requires SENTRY_AUTH_TOKEN or .env.sentry-build-plugin.",
    );
  }
  const cloudflareOptions = browserSmoke
    ? {
        config: { secrets: { required: ["BETTER_AUTH_SECRET"] } },
        configPath: "./tests/browser/wrangler.jsonc",
        persistState: { path: ".wrangler/browser-smoke" },
        remoteBindings: false,
      }
    : command === "build"
      ? { config: { secrets: { required: [] } } }
      : {};

  return {
    build: {
      sourcemap: sentryUploadEnabled ? "hidden" : false,
    },
    plugins: [
      react(),
      cloudflare(cloudflareOptions),
      ...(sentryUploadEnabled
        ? sentryVitePlugin({
            org: "dylandeyunma",
            project: "agent-online",
            sourcemaps: {
              assets: "./dist/**/*.{js,mjs,map}",
              filesToDeleteAfterUpload: "./dist/**/*.map",
            },
            telemetry: false,
          })
        : []),
    ],
    server: {
      port: browserSmoke ? 4173 : 5173,
      strictPort: browserSmoke,
    },
  };
});
