import { createParser, type EventSourceMessage } from "eventsource-parser";
import { describe, expect, it } from "vitest";

import { normalizeStreamingToolProtocol, readOpenAiUsage } from "./model-gateway-protocol";

const usage = { completion_tokens: 4, prompt_tokens: 9, total_tokens: 13 };
const expectedUsage = { inputTokens: 9, modelRequestCount: 1, outputTokens: 4, totalTokens: 13 };

function events(body: string) {
  const result: EventSourceMessage[] = [];
  createParser({ onEvent: (event) => result.push(event) }).feed(body);
  return result;
}

describe("buffered model gateway SSE protocol", () => {
  it.each(["\n", "\r\n", "\r"])(
    "reads complete multiline events with %j line endings",
    (newline) => {
      const body = [
        ": heartbeat",
        "event: message",
        "id: completion-1",
        'data: {"choices": [],',
        `data: "usage": ${JSON.stringify(usage)}}`,
        "",
        "data: [DONE]",
        "",
        "",
      ].join(newline);
      expect(readOpenAiUsage(body, true)).toEqual(expectedUsage);
      const normalized = normalizeStreamingToolProtocol(body);
      expect(readOpenAiUsage(normalized, true)).toEqual(expectedUsage);
      expect(events(normalized)).toEqual([
        {
          event: "message",
          id: "completion-1",
          data: `{"choices": [],\n"usage": ${JSON.stringify(usage)}}`,
        },
        { event: undefined, id: undefined, data: "[DONE]" },
      ]);
      expect(normalized).toContain("id: completion-1\n\n");
      expect(normalized).toContain(":heartbeat\n\n");
    },
  );

  it("requires a blank line instead of treating each data line as an event", () => {
    const data = `data: ${JSON.stringify({ usage })}`;
    expect(readOpenAiUsage(data, true)).toBeNull();
    expect(readOpenAiUsage(`${data}\n`, true)).toBeNull();
    expect(normalizeStreamingToolProtocol(`${data}\n`)).toBe("");
    expect(readOpenAiUsage(`${data}\n\n`, true)).toEqual(expectedUsage);
    expect(readOpenAiUsage(`${data}\ndata: {}\n\n`, true)).toBeNull();
  });

  it("keeps the last valid usage snapshot, ignores empty data and DONE, and never sums snapshots", () => {
    const body = [
      `data: ${JSON.stringify({ usage: { ...usage, total_tokens: 20 } })}`,
      "data:",
      "data: {}",
      `data: ${JSON.stringify({ usage })}`,
      `data: ${JSON.stringify({ usage: { ...usage, total_tokens: 1 } })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    expect(readOpenAiUsage(body, true)).toEqual(expectedUsage);
    expect(readOpenAiUsage(normalizeStreamingToolProtocol(body), true)).toEqual(expectedUsage);
  });

  it.each([true, false])(
    "rejects malformed JSON even when usage is present (malformed first: %s)",
    (first) => {
      const valid = `data: ${JSON.stringify({ usage })}\n\n`;
      const malformed = "data: {broken\ndata: JSON}\n\n";
      const body = first ? malformed + valid : valid + malformed;
      expect(readOpenAiUsage(body, true)).toBeNull();
      const normalized = normalizeStreamingToolProtocol(body);
      expect(normalized).toContain(malformed);
      expect(readOpenAiUsage(normalized, true)).toBeNull();
    },
  );

  it("ignores unknown SSE fields and invalid retry without logging their content", () => {
    const body = `unknown: ignored\nretry: invalid\nretry: 1000\nid:\n\ndata: ${JSON.stringify({ usage })}\n\n`;
    expect(readOpenAiUsage(body, true)).toEqual(expectedUsage);
    const normalized = normalizeStreamingToolProtocol(body);
    expect(normalized).toContain("retry: 1000\n\n");
    expect(normalized).toContain("id: \n\n");
    expect(normalized).not.toContain("ignored");
    expect(readOpenAiUsage(normalized, true)).toEqual(expectedUsage);
  });

  it("normalizes multiline tool signatures once and tracks finish reasons independently per choice", () => {
    const toolDelta = {
      reasoning_details: [{ data: "existing", id: "call-1", type: "reasoning.encrypted" }],
      tool_calls: [
        { id: "call-1", extra_content: { google: { thought_signature: "duplicate" } } },
        { id: "call-2", extra_content: { google: { thought_signature: "new-signature" } } },
      ],
    };
    const body = [
      'data: {"choices": [',
      `data: ${JSON.stringify({ delta: toolDelta, index: 1, finish_reason: null })}]}`,
      "",
      `data: ${JSON.stringify({
        choices: [
          { index: 0, delta: {}, finish_reason: "stop" },
          { index: 1, delta: {}, finish_reason: "stop" },
        ],
      })}`,
      "",
      "data: [DONE]",
      "",
      "",
    ].join("\r\n");
    const parsed = events(normalizeStreamingToolProtocol(body));
    expect(JSON.parse(parsed[0]?.data ?? "").choices[0].delta.reasoning_details).toEqual([
      { data: "existing", id: "call-1", type: "reasoning.encrypted" },
      { data: "new-signature", id: "call-2", type: "reasoning.encrypted" },
    ]);
    expect(JSON.parse(parsed[1]?.data ?? "").choices).toEqual([
      { index: 0, delta: {}, finish_reason: "stop" },
      { index: 1, delta: {}, finish_reason: "tool_calls" },
    ]);
    expect(parsed[2]?.data).toBe("[DONE]");
  });
});
