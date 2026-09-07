import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createE2BFile, exclusiveCreatePython } from "./e2b-files";
import type { E2BSandbox } from "./e2b-types";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function directory() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "agent-online-create-")));
  directories.push(path);
  return path;
}

function create(path: string, content: Uint8Array) {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      "python3",
      ["-I", "-c", exclusiveCreatePython, path, String(content.byteLength)],
      {
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
    child.once("error", reject);
    child.once("exit", resolve);
    child.stdin.on("error", reject);
    child.stdin.end(content);
  });
}

describe("sandbox exclusive creation", () => {
  it("lets exactly one concurrent upload win and retains all of its bytes", async () => {
    const path = join(await directory(), "upload.bin");
    const first = new Uint8Array([0, 255, 1]);
    const second = new Uint8Array([2, 0, 128]);
    const results = await Promise.all([create(path, first), create(path, second)]);
    expect([...results].sort()).toEqual([0, 44]);
    expect(new Uint8Array(await readFile(path))).toEqual(results[0] === 0 ? first : second);
  });

  it("rejects existing directories and dangling target symlinks", async () => {
    const root = await directory();
    const target = join(root, "target");
    const linked = join(root, "linked");
    await symlink(target, linked);
    expect(await create(linked, new Uint8Array([1]))).toBe(44);
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(target);
    expect(await create(target, new Uint8Array([1]))).toBe(44);
  });

  it("rejects symlink parents and supports empty files and shell metacharacters", async () => {
    const root = await directory();
    const outside = await directory();
    await symlink(outside, join(root, "linked"));
    expect(await create(join(root, "linked", "file"), new Uint8Array([1]))).not.toBe(0);
    await expect(readFile(join(outside, "file"))).rejects.toMatchObject({ code: "ENOENT" });
    const path = join(root, "quote'$(false).txt");
    expect(await create(path, new Uint8Array())).toBe(0);
    expect((await readFile(path)).byteLength).toBe(0);
  });
});

describe("E2B exclusive creation transport", () => {
  it("kills and disconnects the receiving process after a partial stdin failure", async () => {
    const failure = new Error("Provider transport failed");
    const process = {
      sendStdin: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure),
      kill: vi.fn().mockResolvedValue(true),
      disconnect: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn(),
    };
    const sandbox = {
      commands: { run: vi.fn().mockResolvedValue(process) },
    } as unknown as E2BSandbox;
    const content = new Uint8Array(128 * 1_024 + 1);
    await expect(createE2BFile(sandbox, "/workspace/input.bin", content)).rejects.toBe(failure);
    expect(process.sendStdin).toHaveBeenCalledTimes(2);
    expect(process.sendStdin.mock.calls[0]?.[0]).toHaveLength(64 * 1_024);
    expect(process.sendStdin.mock.calls[1]?.[0]).toHaveLength(64 * 1_024);
    expect(process.kill).toHaveBeenCalledOnce();
    expect(process.disconnect).toHaveBeenCalledOnce();
    expect(process.wait).not.toHaveBeenCalled();
  });
});
