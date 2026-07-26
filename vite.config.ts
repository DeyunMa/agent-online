import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    cloudflare({
      // Build artifacts use remotely configured Wrangler secrets, never local dev vars.
      config:
        command === "build" ? { secrets: { required: [] } } : undefined,
    }),
  ],
  server: {
    port: 5173,
  },
}));
