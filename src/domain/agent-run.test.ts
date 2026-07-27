import { describe, expect, it } from "vitest";

import {
  canCreateAgentRun,
  canTransitionAgentRun,
  isTerminalAgentRun,
  isValidAgentRunFailure,
} from "./agent-run";

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

  it("keeps failure codes consistent with terminal status", () => {
    expect(isValidAgentRunFailure("failed", "run.model_failed")).toBe(true);
    expect(isValidAgentRunFailure("failed", null)).toBe(false);
    expect(isValidAgentRunFailure("timed_out", "run.timed_out")).toBe(true);
    expect(isValidAgentRunFailure("timed_out", "run.internal_failed")).toBe(false);
    expect(isValidAgentRunFailure("interrupted", "run.interrupted")).toBe(true);
    expect(isValidAgentRunFailure("succeeded", null)).toBe(true);
    expect(isValidAgentRunFailure("succeeded", "run.internal_failed")).toBe(false);
  });
});
