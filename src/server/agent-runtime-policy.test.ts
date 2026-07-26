import { describe, expect, it } from "vitest";

import type { AppBindings } from "./env";
import {
  getAgentRuntimePolicy,
  getGooseRuntimeMode,
} from "./agent-runtime-policy";

describe("AgentRuntime policy", () => {
  it("defaults to Pi-only execution and public capabilities", () => {
    const policy = getAgentRuntimePolicy({} as AppBindings, "e2b");

    expect(policy.executionRuntimeIds).toEqual(["pi"]);
    expect(policy.publicRuntimeIds).toEqual(["pi"]);
    expect(() => policy.resolve("goose")).toThrow("not enabled");
  });

  it("allows Goose for an E2B spike without publishing it", () => {
    const policy = getAgentRuntimePolicy(
      { GOOSE_RUNTIME_MODE: "spike" } as AppBindings,
      "e2b",
    );

    expect(policy.executionRuntimeIds).toEqual(["pi", "goose"]);
    expect(policy.publicRuntimeIds).toEqual(["pi"]);
    expect(policy.resolve("goose").id).toBe("goose");
  });

  it("publishes Goose only in public mode with E2B", () => {
    const e2bPolicy = getAgentRuntimePolicy(
      { GOOSE_RUNTIME_MODE: "public" } as AppBindings,
      "e2b",
    );
    const fakePolicy = getAgentRuntimePolicy(
      { GOOSE_RUNTIME_MODE: "public" } as AppBindings,
      "fake",
    );

    expect(e2bPolicy.publicRuntimeIds).toEqual(["pi", "goose"]);
    expect(fakePolicy.executionRuntimeIds).toEqual(["pi"]);
    expect(fakePolicy.publicRuntimeIds).toEqual(["pi"]);
  });

  it("rejects unknown modes", () => {
    expect(() =>
      getGooseRuntimeMode({
        GOOSE_RUNTIME_MODE: "enabled",
      } as AppBindings),
    ).toThrow("GOOSE_RUNTIME_MODE");
  });
});
