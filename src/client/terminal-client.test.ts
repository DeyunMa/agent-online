import { describe, expect, it } from "vitest";

import { parseTerminalServerMessage, takeUtf8Prefix } from "./terminal-client";

describe("Terminal browser protocol", () => {
  it("accepts only public normalized server messages", () => {
    expect(
      parseTerminalServerMessage('{"type":"ready","expiresAt":"2026-07-26T08:30:00.000Z"}'),
    ).toEqual({
      expiresAt: "2026-07-26T08:30:00.000Z",
      type: "ready",
    });
    expect(parseTerminalServerMessage('{"type":"closed","exitCode":0}')).toEqual({
      exitCode: 0,
      type: "closed",
    });
    expect(parseTerminalServerMessage('{"type":"error","code":"project_busy"}')).toEqual({
      code: "project_busy",
      type: "error",
    });
  });

  it("rejects malformed or provider-specific payloads", () => {
    expect(parseTerminalServerMessage("not-json")).toBeNull();
    expect(parseTerminalServerMessage('{"type":"ready","providerSandboxId":"private"}')).toBeNull();
    expect(parseTerminalServerMessage('{"type":"error","code":"e2b_internal"}')).toBeNull();
  });

  it("chunks terminal input on UTF-8 boundaries", () => {
    expect(takeUtf8Prefix("abc中文def", 7)).toEqual({
      chunk: "abc中",
      remaining: "文def",
    });
    expect(takeUtf8Prefix("plain", 8)).toEqual({
      chunk: "plain",
      remaining: "",
    });
  });
});
