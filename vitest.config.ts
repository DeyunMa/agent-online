import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["src/**/*.cloudflare.test.ts"],
    include: ["src/**/*.test.ts"],
  },
});
