import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-import-boundaries.mjs", import.meta.url));

for (const scenario of [
  { file: "src/server/example.ts", source: 'import "@/components/example";', allowed: false },
  { file: "src/client/example.ts", source: 'import "@/components/example";', allowed: true },
  {
    file: "src/domain/example.ts",
    source: 'export * from "@/components/example";',
    allowed: false,
  },
  { file: "src/application/example.ts", source: 'import("@/components/example");', allowed: false },
  { file: "src/server/example.ts", source: 'import "../domain/example";', allowed: true },
]) {
  test(`${scenario.file}: ${scenario.source}`, () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-online-boundaries-"));
    try {
      mkdirSync(path.join(root, path.dirname(scenario.file)), { recursive: true });
      mkdirSync(path.join(root, "worker"));
      writeFileSync(path.join(root, scenario.file), scenario.source);
      writeFileSync(
        path.join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { paths: { "@/*": ["./src/client/*"] } },
        }),
      );
      const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, scenario.allowed ? 0 : 1, result.stdout + result.stderr);
      if (!scenario.allowed) assert.match(result.stderr, /cannot import client/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
