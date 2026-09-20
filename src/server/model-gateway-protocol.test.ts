import { describe, expect, it } from "vitest";

import { readOpenAiUsage } from "./model-gateway-protocol";

const usage = { completion_tokens: 4, prompt_tokens: 9, total_tokens: 13 };
const expectedUsage = { inputTokens: 9, modelRequestCount: 1, outputTokens: 4, totalTokens: 13 };

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
    },
  );

  it("requires a blank line instead of treating each data line as an event", () => {
    const data = `data: ${JSON.stringify({ usage })}`;
    expect(readOpenAiUsage(data, true)).toBeNull();
    expect(readOpenAiUsage(`${data}\n`, true)).toBeNull();
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
  });

  it.each([true, false])(
    "rejects malformed JSON even when usage is present (malformed first: %s)",
    (first) => {
      const valid = `data: ${JSON.stringify({ usage })}\n\n`;
      const malformed = "data: {broken\ndata: JSON}\n\n";
      const body = first ? malformed + valid : valid + malformed;
      expect(readOpenAiUsage(body, true)).toBeNull();
    },
  );

  it("ignores unknown SSE fields and invalid retry without logging their content", () => {
    const body = `unknown: ignored\nretry: invalid\nretry: 1000\nid:\n\ndata: ${JSON.stringify({ usage })}\n\n`;
    expect(readOpenAiUsage(body, true)).toEqual(expectedUsage);
  });
});
