import { describe, expect, it } from "vitest";
import {
  agentRunResponseSchema,
  createAgentRunRequestSchema,
  userUsageResponseSchema,
} from "./api";

describe("retired runtime history", () => {
  it("reads historical identifiers without allowing new execution", () => {
    expect(agentRunResponseSchema.shape.agentRuntimeId.parse("goose")).toBe("goose");
    expect(
      userUsageResponseSchema.shape.agentRuntimes.element.shape.agentRuntimeId.parse("goose"),
    ).toBe("goose");
    expect(
      createAgentRunRequestSchema.safeParse({ agentRuntimeId: "goose", content: "task" }).success,
    ).toBe(false);
    expect(
      createAgentRunRequestSchema.safeParse({ agentRuntimeId: "pi", content: "task" }).success,
    ).toBe(true);
  });
});
