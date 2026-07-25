import { describe, expect, it } from "vitest";

import { canStartSandboxLease, isActiveSandboxLease } from "./sandbox-lease";

describe("sandbox lease state", () => {
  it("allows a project to start when no lease is active", () => {
    expect(canStartSandboxLease(null)).toBe(true);
    expect(canStartSandboxLease("stopped")).toBe(true);
    expect(canStartSandboxLease("failed")).toBe(true);
  });

  it("treats live lease states as active", () => {
    expect(isActiveSandboxLease("starting")).toBe(true);
    expect(isActiveSandboxLease("busy")).toBe(true);
    expect(isActiveSandboxLease("stopped")).toBe(false);
    expect(canStartSandboxLease("idle")).toBe(false);
  });
});
