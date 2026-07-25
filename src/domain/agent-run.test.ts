import { describe, expect, it } from "vitest";

import { canCreateAgentRun, canTransitionAgentRun, isTerminalAgentRun } from "./agent-run";

describe("AgentRun state", () => {
  it("allows only one non-terminal AgentRun per Project", () => {
    expect(canCreateAgentRun(null)).toBe(true);
    expect(canCreateAgentRun("succeeded")).toBe(true);
    expect(canCreateAgentRun("running")).toBe(false);
    expect(canCreateAgentRun("cancelling")).toBe(false);
  });

  it("keeps terminal states terminal", () => {
    expect(isTerminalAgentRun("cancelled")).toBe(true);
    expect(isTerminalAgentRun("running")).toBe(false);
    expect(canTransitionAgentRun("running", "succeeded")).toBe(true);
    expect(canTransitionAgentRun("succeeded", "running")).toBe(false);
  });
});
