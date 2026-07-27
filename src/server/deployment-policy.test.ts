import { describe, expect, it } from "vitest";

import { getDeploymentPolicy, isEmailAllowed } from "./deployment-policy";

const testAllowedEmails = ["Owner@Example.test", "invited@example.test"].join(", ");

describe("deployment policy", () => {
  it("keeps local development unrestricted by default", () => {
    const policy = getDeploymentPolicy({});

    expect(policy.accessMode).toBe("open");
    expect(policy.runsEnabled).toBe(true);
    expect(isEmailAllowed(policy, "anyone@example.test")).toBe(true);
  });

  it("normalizes an invite-only email allowlist", () => {
    const policy = getDeploymentPolicy({
      ACCESS_ALLOWED_EMAILS: testAllowedEmails,
      ACCESS_MODE: "allowlist",
      RUNS_ENABLED: "false",
    });

    expect(policy.runsEnabled).toBe(false);
    expect(policy.accessMode).toBe("allowlist");
    expect(isEmailAllowed(policy, "owner@example.test")).toBe(true);
    expect(isEmailAllowed(policy, "INVITED@example.test")).toBe(true);
    expect(isEmailAllowed(policy, "other@example.test")).toBe(false);
  });

  it("rejects ambiguous deployment values", () => {
    expect(() =>
      getDeploymentPolicy({
        ACCESS_ALLOWED_EMAILS: "  ",
        ACCESS_MODE: "allowlist",
      }),
    ).toThrow("ACCESS_ALLOWED_EMAILS");
    expect(() => getDeploymentPolicy({ ACCESS_MODE: "private" })).toThrow("ACCESS_MODE");
    expect(() => getDeploymentPolicy({ RUNS_ENABLED: "sometimes" })).toThrow("RUNS_ENABLED");
  });
});
