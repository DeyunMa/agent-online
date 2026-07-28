import { defaultPreviewSessionDurationMs } from "../application/project-preview";
import { defaultTerminalSessionDurationMs } from "../application/project-terminal";
import { E2BSandboxRuntime } from "../runtime/e2b-runtime";
import type { AppBindings } from "./env";
import { getE2BExecutionConfig, type E2BExecutionConfig } from "./runtime-config";

export type E2BRuntimeBundle = {
  config: E2BExecutionConfig;
  runtime: E2BSandboxRuntime;
};

export function createE2BSandboxRuntime(env: AppBindings): E2BRuntimeBundle {
  const config = getE2BExecutionConfig(env);
  const longestActivityMs = Math.max(
    config.runTimeoutMs,
    defaultPreviewSessionDurationMs,
    defaultTerminalSessionDurationMs,
  );

  return {
    config,
    runtime: new E2BSandboxRuntime({
      apiKey: config.apiKey,
      processTimeoutMs: config.runTimeoutMs + 15_000,
      sandboxTimeoutMs: longestActivityMs + config.idleTtlMs + 60_000,
      templateId: config.templateId,
    }),
  };
}
