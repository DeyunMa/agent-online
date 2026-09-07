import { SandboxPathConflictError, SandboxPathNotFoundError } from "./contract";
import { toShellCommand } from "./e2b-shell";
import type { E2BSandbox } from "./e2b-types";

// Receive the complete bounded body before creating the target. Each directory is
// opened without following symlinks; O_EXCL makes competing uploads fail closed.
export const exclusiveCreatePython = `import os, sys
path, length = sys.argv[1], int(sys.argv[2])
parts = path.split('/')
if not path.startswith('/') or any(p in ('', '.', '..') for p in parts[1:]):
    sys.exit(45)
data = sys.stdin.buffer.read(length)
if len(data) != length:
    sys.exit(45)
parent = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
try:
    for part in parts[1:-1]:
        child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        os.close(parent)
        parent = child
    try:
        target = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=parent)
    except FileExistsError:
        sys.exit(44)
    with os.fdopen(target, 'wb') as output:
        output.write(data)
except FileNotFoundError:
    sys.exit(46)
finally:
    os.close(parent)
`;

export async function createE2BFile(sandbox: E2BSandbox, path: string, content: Uint8Array) {
  const process = await sandbox.commands.run(
    toShellCommand({
      command: "/usr/bin/env",
      args: [
        "-i",
        "/usr/bin/python3",
        "-I",
        "-c",
        exclusiveCreatePython,
        path,
        String(content.byteLength),
      ],
    }),
    { background: true, cwd: "/", stdin: true, timeoutMs: 30_000 },
  );
  try {
    // Bound each provider message without putting user bytes in command arguments.
    for (let offset = 0; offset < content.byteLength; offset += 64 * 1_024) {
      await process.sendStdin(content.subarray(offset, offset + 64 * 1_024));
    }
    const result = await process.wait();
    assertCreateResult(result.exitCode, path);
  } catch (error) {
    await process.kill().catch(() => false);
    if (
      error &&
      typeof error === "object" &&
      "exitCode" in error &&
      typeof error.exitCode === "number"
    ) {
      assertCreateResult(error.exitCode, path);
    }
    throw error;
  } finally {
    await process.disconnect().catch(() => undefined);
  }
}

function assertCreateResult(exitCode: number, path: string) {
  if (exitCode === 44) throw new SandboxPathConflictError();
  if (exitCode === 46) throw new SandboxPathNotFoundError(path);
  if (exitCode !== 0) throw new Error("Sandbox exclusive file creation failed");
}
