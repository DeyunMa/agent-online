import { describe, expect, it } from "vitest";

import { defaultAgentRuntimeId, getAgentRuntime } from "./registry";

describe("AgentRuntime registry", () => {
  it("exposes Pi as the only installed default runtime", () => {
    expect(defaultAgentRuntimeId).toBe("pi");
    expect(getAgentRuntime(defaultAgentRuntimeId).id).toBe("pi");
  });

  it("rejects a runtime that is only reserved by the contract", () => {
    expect(() => getAgentRuntime("goose")).toThrow("Agent runtime is not installed: goose");
  });
});
