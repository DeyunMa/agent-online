import { CommandExitError } from "e2b";

import type { SandboxChangeDiff, SandboxChangeEntry } from "./contract";
import { isSupportedSandboxChangePath, SandboxNotRepositoryError } from "./contract";
import { toShellCommand } from "./e2b-shell";
import type { E2BSandbox } from "./e2b-types";
import {
  maxGitDiffSectionBytes,
  maxGitStatusBytes,
  parseGitStatusOutput,
  truncateUtf8,
} from "./git-changes";

const changesWorkingDirectory = "/workspace";
const maxGitConfigBytes = 64 * 1_024;

export async function listE2BChanges(sandbox: E2BSandbox, timeoutMs: number) {
  await assertSafeGitConfiguration(sandbox, timeoutMs);
  const result = await runBoundedGitCommand(
    sandbox,
    changesWorkingDirectory,
    [
      "--no-pager",
      "--literal-pathspecs",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=all",
    ],
    maxGitStatusBytes + 1,
    timeoutMs,
  );
  const bounded = truncateUtf8(result.stdout, maxGitStatusBytes);
  if (result.exitCode === 44) {
    throw new SandboxNotRepositoryError();
  }
  if (result.exitCode !== 0 && !(result.exitCode === 141 && bounded.truncated)) {
    throw new Error("Git status failed");
  }

  return parseGitStatusOutput(bounded.text, bounded.truncated);
}

export async function readE2BChangeDiff(
  sandbox: E2BSandbox,
  change: SandboxChangeEntry,
  timeoutMs: number,
): Promise<SandboxChangeDiff> {
  assertSandboxChange(change);
  await assertSafeGitConfiguration(sandbox, timeoutMs);
  const staged = change.stagedKind
    ? await readGitDiffSection(
        sandbox,
        changesWorkingDirectory,
        createTrackedDiffArgs(change, true),
        timeoutMs,
        false,
      )
    : null;
  const unstaged = change.unstagedKind
    ? await readGitDiffSection(
        sandbox,
        changesWorkingDirectory,
        change.unstagedKind === "untracked"
          ? createUntrackedDiffArgs(change.path)
          : createTrackedDiffArgs(change, false),
        timeoutMs,
        change.unstagedKind === "untracked",
      )
    : null;

  return { staged, unstaged };
}

const boundedGitCommandScript = `
set -uo pipefail
[ -d "$GIT_DIR" ] && [ ! -L "$GIT_DIR" ] || exit 44
[ -f "$GIT_DIR/config" ] && [ ! -L "$GIT_DIR/config" ] || exit 45
[ ! -e "$GIT_DIR/commondir" ] && [ ! -L "$GIT_DIR/commondir" ] || exit 46
[ ! -e "$GIT_DIR/config.worktree" ] && [ ! -L "$GIT_DIR/config.worktree" ] || exit 47
/usr/bin/env -i \
  GIT_ATTR_NOSYSTEM=1 \
  GIT_CONFIG_GLOBAL=/dev/null \
  GIT_CONFIG_NOSYSTEM=1 \
  GIT_DIR=/workspace/.git \
  GIT_LITERAL_PATHSPECS=1 \
  GIT_NO_LAZY_FETCH=1 \
  GIT_OPTIONAL_LOCKS=0 \
  GIT_PAGER=cat \
  GIT_TERMINAL_PROMPT=0 \
  GIT_WORK_TREE=/workspace \
  HOME=/tmp/agent-online-git-home \
  LC_ALL=C \
  PATH=/usr/bin:/bin \
  XDG_CONFIG_HOME=/tmp/agent-online-git-home \
  /usr/bin/git "$@" 2>/dev/null |
  /usr/bin/head -c "$AGENT_ONLINE_OUTPUT_LIMIT"
`.trim();

async function assertSafeGitConfiguration(sandbox: E2BSandbox, timeoutMs: number) {
  const result = await runBoundedGitCommand(
    sandbox,
    changesWorkingDirectory,
    [
      "--no-pager",
      "config",
      "--file",
      "/workspace/.git/config",
      "--no-includes",
      "--name-only",
      "--null",
      "--list",
    ],
    maxGitConfigBytes + 1,
    timeoutMs,
  );
  const bounded = truncateUtf8(result.stdout, maxGitConfigBytes);
  if (result.exitCode === 44) {
    throw new SandboxNotRepositoryError();
  }
  if (result.exitCode !== 0 || bounded.truncated) {
    throw new Error("Git configuration validation failed");
  }

  const keys = bounded.text
    .split("\0")
    .filter(Boolean)
    .map((key) => key.toLowerCase());
  if (keys.some(isUnsafeGitConfigurationKey)) {
    throw new Error("Git configuration is not safe for Changes");
  }
}

function isUnsafeGitConfigurationKey(key: string) {
  return (
    key.startsWith("include.") ||
    key.startsWith("includeif.") ||
    key.startsWith("filter.") ||
    key === "extensions.worktreeconfig" ||
    key === "diff.external" ||
    /^diff\..+\.(command|textconv)$/u.test(key) ||
    key === "core.attributesfile" ||
    key === "core.fsmonitor" ||
    key === "core.hookspath" ||
    key === "core.worktree"
  );
}

async function readGitDiffSection(
  sandbox: E2BSandbox,
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
  allowDifferenceExitCode: boolean,
) {
  const result = await runBoundedGitCommand(
    sandbox,
    cwd,
    args,
    maxGitDiffSectionBytes + 1,
    timeoutMs,
  );
  const bounded = truncateUtf8(result.stdout, maxGitDiffSectionBytes);
  if (result.exitCode === 44) {
    throw new SandboxNotRepositoryError();
  }
  if (
    result.exitCode !== 0 &&
    !(allowDifferenceExitCode && result.exitCode === 1) &&
    !(result.exitCode === 141 && bounded.truncated)
  ) {
    throw new Error("Git diff failed");
  }

  return {
    content: bounded.text,
    truncated: bounded.truncated,
  };
}

async function runBoundedGitCommand(
  sandbox: E2BSandbox,
  cwd: string,
  gitArgs: readonly string[],
  outputLimitBytes: number,
  timeoutMs: number,
) {
  const process = await sandbox.commands.run(
    toShellCommand({
      args: [
        "-i",
        `AGENT_ONLINE_OUTPUT_LIMIT=${outputLimitBytes}`,
        "GIT_DIR=/workspace/.git",
        "/bin/bash",
        "--noprofile",
        "--norc",
        "-c",
        boundedGitCommandScript,
        "agent-online-git",
        ...gitArgs,
      ],
      command: "/usr/bin/env",
    }),
    {
      background: true,
      cwd,
      timeoutMs,
    },
  );

  try {
    return await process.wait();
  } catch (error) {
    if (error instanceof CommandExitError) {
      return error;
    }
    throw error;
  }
}

function createTrackedDiffArgs(change: SandboxChangeEntry, staged: boolean) {
  const paths = change.previousPath === null ? [change.path] : [change.previousPath, change.path];
  return [
    "--no-pager",
    "--literal-pathspecs",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "diff",
    ...(staged ? ["--cached"] : []),
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=all",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--",
    ...paths,
  ];
}

function createUntrackedDiffArgs(path: string) {
  return [
    "--no-pager",
    "--literal-pathspecs",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "diff",
    "--no-index",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--",
    "/dev/null",
    path,
  ];
}

function assertSandboxChange(change: SandboxChangeEntry) {
  if (
    !isSupportedSandboxChangePath(change.path) ||
    (change.previousPath !== null && !isSupportedSandboxChangePath(change.previousPath)) ||
    (!change.stagedKind && !change.unstagedKind)
  ) {
    throw new Error("E2B Changes entry is invalid");
  }
}
