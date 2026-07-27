import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command, mode }) => {
  const browserSmoke = mode === "browser-smoke";

  return {
    plugins: [
      react(),
      cloudflare({
        config: browserSmoke
          ? { secrets: { required: ["BETTER_AUTH_SECRET"] } }
          : command === "build"
            ? { secrets: { required: [] } }
            : undefined,
        configPath: browserSmoke ? "./tests/browser/wrangler.jsonc" : undefined,
        persistState: browserSmoke ? { path: ".wrangler/browser-smoke" } : undefined,
        remoteBindings: browserSmoke ? false : undefined,
      }),
    ],
    server: {
      port: browserSmoke ? 4173 : 5173,
      strictPort: browserSmoke,
    },
  };
});
