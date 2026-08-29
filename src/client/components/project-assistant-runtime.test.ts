import { describe, expect, it } from "vitest";

import { toAssistantUiMessage } from "./project-assistant-runtime";

describe("toAssistantUiMessage", () => {
  it("preserves the D1 message identity, role, timestamp, and plain-text content", () => {
    const result = toAssistantUiMessage({
      agentRunId: "run-123",
      content: "Implement the requested change.",
      createdAt: "2026-08-29T08:00:00.000Z",
      id: "message-123",
      role: "assistant",
      sequence: 7,
    });

    expect(result.id).toBe("message-123");
    expect(result.role).toBe("assistant");
    expect(result.createdAt).toEqual(new Date("2026-08-29T08:00:00.000Z"));
    expect(result.content).toEqual([{ text: "Implement the requested change.", type: "text" }]);
    expect(result.status).toMatchObject({ type: "complete" });
  });
});
