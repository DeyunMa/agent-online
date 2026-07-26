import { describe, expect, it } from "vitest";

import { defaultAgentRuntimeId, getAgentRuntime } from "./registry";

describe("AgentRuntime registry", () => {
  it("exposes Pi as the installed default runtime", () => {
    expect(defaultAgentRuntimeId).toBe("pi");
    expect(getAgentRuntime(defaultAgentRuntimeId).id).toBe("pi");
  });

  it("installs Goose as a separately gated adapter", () => {
    expect(getAgentRuntime("goose").id).toBe("goose");
  });

  it("rejects a runtime that is only reserved by the contract", () => {
    expect(() => getAgentRuntime("claude-code")).toThrow(
      "Agent runtime is not installed: claude-code",
    );
  });
});
