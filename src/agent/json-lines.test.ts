import { describe, expect, it } from "vitest";
import { AgentJsonLines, maxAgentRecordBytes } from "./json-lines";

describe("bounded Agent JSONL", () => {
  it("preserves fragmented JSON, CRLF, and Unicode separators with LF-only framing", () => {
    const lines = new AgentJsonLines();
    expect([...lines.read('{"text":"before')]).toEqual([]);
    expect([...lines.read('\u2028after"}\r\n\n{"last":true}')]).toEqual([
      { text: "before\u2028after" },
    ]);
    expect([...lines.finish()]).toEqual([{ last: true }]);
  });

  it("rejects cumulative incomplete records by UTF-8 bytes", () => {
    const lines = new AgentJsonLines();
    expect([...lines.read("界".repeat(Math.floor(maxAgentRecordBytes / 3)))]).toEqual([]);
    expect(() => [...lines.read("界")]).toThrow("record limit exceeded");
  });

  it("bounds each line while allowing many bounded records in a chunk", () => {
    const lines = new AgentJsonLines();
    const line = JSON.stringify({ value: "x".repeat(maxAgentRecordBytes / 2) }) + "\n";
    expect([...lines.read(line.repeat(3))]).toHaveLength(3);
  });
});
