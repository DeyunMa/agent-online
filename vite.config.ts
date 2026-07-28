import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command, mode }) => {
  const browserSmoke = mode === "browser-smoke";
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
    plugins: [react(), cloudflare(cloudflareOptions)],
    server: {
      port: browserSmoke ? 4173 : 5173,
      strictPort: browserSmoke,
    },
  };
});
