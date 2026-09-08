import { defineConfig } from "drizzle-kit";

// Offline schema export only. Wrangler applies the reviewed migrations/ history;
// this config intentionally has no database URL, D1 credentials, or remote driver.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/persistence/schema.ts",
});
