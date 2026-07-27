import type { SandboxChangeEntry, SandboxChangeKind, SandboxChangesSnapshot } from "./contract";
import { isSupportedSandboxChangePath } from "./contract";

export const maxGitStatusBytes = 128 * 1_024;
export const maxGitStatusEntries = 500;
export const maxGitDiffSectionBytes = 128 * 1_024;

const conflictStatuses = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function parseGitStatusOutput(
  output: string,
  outputTruncated: boolean,
): SandboxChangesSnapshot {
  const entries: SandboxChangeEntry[] = [];
  let cursor = 0;
  let truncated = outputTruncated;
  let unsupportedEntries = false;

  while (cursor < output.length) {
    if (entries.length >= maxGitStatusEntries) {
      truncated = true;
      break;
    }

    const recordEnd = output.indexOf("\0", cursor);
    if (recordEnd < 0) {
      truncated = true;
      break;
    }

    const record = output.slice(cursor, recordEnd);
    cursor = recordEnd + 1;
    if (record.length < 4 || record[2] !== " ") {
      throw new InvalidGitStatusError();
    }

    const indexStatus = record[0] ?? " ";
    const worktreeStatus = record[1] ?? " ";
    const status = `${indexStatus}${worktreeStatus}`;
    const path = record.slice(3);
    let previousPath: string | null = null;

    if (
      indexStatus === "R" ||
      indexStatus === "C" ||
      worktreeStatus === "R" ||
      worktreeStatus === "C"
    ) {
      const previousPathEnd = output.indexOf("\0", cursor);
      if (previousPathEnd < 0) {
        truncated = true;
        break;
      }
      previousPath = output.slice(cursor, previousPathEnd);
      cursor = previousPathEnd + 1;
    }

    if (status === "!!") {
      continue;
    }
    if (
      !isSupportedSandboxChangePath(path) ||
      (previousPath !== null && !isSupportedSandboxChangePath(previousPath))
    ) {
      unsupportedEntries = true;
      continue;
    }

    entries.push({
      path,
      previousPath,
      stagedKind: status === "??" ? null : toStageKind(indexStatus, status),
      unstagedKind: status === "??" ? "untracked" : toStageKind(worktreeStatus, status),
    });
  }

  return { entries, truncated, unsupportedEntries };
}

export function truncateUtf8(
  value: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) {
    return { text: value, truncated: false };
  }

  let end = maxBytes;
  while (end > 0) {
    try {
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, end)),
        truncated: true,
      };
    } catch {
      end -= 1;
    }
  }

  return { text: "", truncated: true };
}

function toStageKind(stageStatus: string, status: string): SandboxChangeKind | null {
  if (conflictStatuses.has(status) || stageStatus === "U") {
    return "conflicted";
  }
  if (stageStatus === " ") {
    return null;
  }
  if (stageStatus === "R") {
    return "renamed";
  }
  if (stageStatus === "D") {
    return "deleted";
  }
  if (stageStatus === "T") {
    return "type_changed";
  }
  if (stageStatus === "A" || stageStatus === "C") {
    return "added";
  }
  return "modified";
}

export class InvalidGitStatusError extends Error {
  constructor() {
    super("Git returned an invalid porcelain status");
    this.name = "InvalidGitStatusError";
  }
}
