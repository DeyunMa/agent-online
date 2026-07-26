import { describe, expect, it } from "vitest";

import {
  getDefaultModelId,
  getE2BExecutionConfig,
  getInstalledSandboxRuntimeId,
} from "./runtime-config";
import type { AppBindings } from "./env";

describe("runtime config", () => {
  it("keeps local development on fake unless E2B is selected explicitly", () => {
    expect(getInstalledSandboxRuntimeId(binding())).toBe("fake");
    expect(getDefaultModelId(binding())).toBe("gemini-3.6-flash");
  });

  it("builds a bounded E2B execution configuration without requiring another public URL", () => {
    const config = getE2BExecutionConfig(
      binding({
        BETTER_AUTH_SECRET: "a".repeat(32),
        BETTER_AUTH_URL: "https://agent-online.example/",
        E2B_API_KEY: "e2b-key",
        E2B_TEMPLATE_ID: "agent-online-template",
        MAX_RUN_WALL_SECONDS: "900",
        RUNTIME_IDLE_TTL_SECONDS: "300",
      }),
    );

    expect(config).toMatchObject({
      idleTtlMs: 300_000,
      modelGatewayBaseUrl: "https://agent-online.example/api/model-gateway/v1",
      modelMaxOutputTokens: 4_096,
      runTimeoutMs: 900_000,
      templateId: "agent-online-template",
      workingDirectory: "/workspace",
    });
  });

  it("accepts a public tunnel override for local E2B development", () => {
    const config = getE2BExecutionConfig(
      binding({
        BETTER_AUTH_SECRET: "a".repeat(32),
        BETTER_AUTH_URL: "http://localhost:5173",
        E2B_API_KEY: "e2b-key",
        E2B_TEMPLATE_ID: "agent-online-template",
        MODEL_GATEWAY_BASE_URL: "https://local-tunnel.example/some-path",
      }),
    );

    expect(config.modelGatewayBaseUrl).toBe(
      "https://local-tunnel.example/api/model-gateway/v1",
    );
  });

  it("rejects unsupported providers and capability lifetimes over one hour", () => {
    expect(() => getInstalledSandboxRuntimeId(binding({ RUNTIME_PROVIDER: "unknown" }))).toThrow(
      "fake or e2b",
    );
    expect(() =>
      getE2BExecutionConfig(
        binding({
          BETTER_AUTH_SECRET: "a".repeat(32),
          BETTER_AUTH_URL: "https://agent-online.example",
          E2B_API_KEY: "e2b-key",
          E2B_TEMPLATE_ID: "agent-online-template",
          MAX_RUN_WALL_SECONDS: "3601",
        }),
      ),
    ).toThrow("between 1 and 3600");
  });
});

function binding(overrides: Partial<AppBindings> = {}) {
  return {
    AGENT_RUN_WORKFLOW: {} as Workflow,
    ASSETS: {} as Fetcher,
    DB: {} as D1Database,
    ...overrides,
  } satisfies AppBindings;
}
