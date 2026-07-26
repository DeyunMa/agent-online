import { describe, expect, it } from "vitest";

import {
  maxGitStatusBytes,
  maxGitStatusEntries,
  parseGitStatusOutput,
  truncateUtf8,
} from "./git-changes";

describe("Git Changes parsing", () => {
  it("normalizes staged, unstaged, untracked, renamed, and conflicted records", () => {
    const output = [
      "M  staged.ts\0",
      " M unstaged.ts\0",
      "?? new.ts\0",
      "R  renamed.ts\0old.ts\0",
      "MD mixed.ts\0",
      "UU conflict.ts\0",
    ].join("");

    expect(parseGitStatusOutput(output, false)).toEqual({
      entries: [
        {
          path: "staged.ts",
          previousPath: null,
          stagedKind: "modified",
          unstagedKind: null,
        },
        {
          path: "unstaged.ts",
          previousPath: null,
          stagedKind: null,
          unstagedKind: "modified",
        },
        {
          path: "new.ts",
          previousPath: null,
          stagedKind: null,
          unstagedKind: "untracked",
        },
        {
          path: "renamed.ts",
          previousPath: "old.ts",
          stagedKind: "renamed",
          unstagedKind: null,
        },
        {
          path: "mixed.ts",
          previousPath: null,
          stagedKind: "modified",
          unstagedKind: "deleted",
        },
        {
          path: "conflict.ts",
          previousPath: null,
          stagedKind: "conflicted",
          unstagedKind: "conflicted",
        },
      ],
      truncated: false,
      unsupportedEntries: false,
    });
  });

  it("marks private or unsupported paths and detects partial records", () => {
    const output =
      " M .git/config\0 M ../outside\0 M safe.ts\0 M partial";

    expect(parseGitStatusOutput(output, false)).toEqual({
      entries: [
        {
          path: "safe.ts",
          previousPath: null,
          stagedKind: null,
          unstagedKind: "modified",
        },
      ],
      truncated: true,
      unsupportedEntries: true,
    });
  });

  it("bounds entry count independently from the byte budget", () => {
    const output = Array.from(
      { length: maxGitStatusEntries + 1 },
      (_, index) => ` M file-${index}.ts\0`,
    ).join("");
    const parsed = parseGitStatusOutput(output, false);

    expect(parsed.entries).toHaveLength(maxGitStatusEntries);
    expect(parsed.truncated).toBe(true);
    expect(parsed.unsupportedEntries).toBe(false);
  });

  it("truncates UTF-8 by bytes", () => {
    const value = "a".repeat(maxGitStatusBytes) + "界";
    const result = truncateUtf8(value, maxGitStatusBytes);

    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(
      maxGitStatusBytes,
    );
    expect(result.truncated).toBe(true);
  });
});
