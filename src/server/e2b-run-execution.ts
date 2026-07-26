import { RunExecutionService } from "../application/run-execution";
import { E2BSandboxRuntime } from "../runtime/e2b-runtime";
import type { RuntimeKind } from "../runtime/contract";
import type { AppBindings } from "./env";
import { getAgentRuntimePolicy } from "./agent-runtime-policy";
import {
  D1AgentRunRepository,
  D1MessageRepository,
  D1SandboxLeaseRepository,
} from "./persistence/d1-repositories";
import { createRunCapabilityCodec } from "./run-capability";
import {
  getE2BExecutionConfig,
  type E2BExecutionConfig,
} from "./runtime-config";

export type E2BRunExecution = {
  config: E2BExecutionConfig;
  runtime: E2BSandboxRuntime;
  service: RunExecutionService;
};

export function createE2BRunExecution(env: AppBindings): E2BRunExecution {
  const config = getE2BExecutionConfig(env);
  const agentRuntimePolicy = getAgentRuntimePolicy(env, "e2b");
  const runtime = new E2BSandboxRuntime({
    apiKey: config.apiKey,
    processTimeoutMs: config.runTimeoutMs + 15_000,
    sandboxTimeoutMs:
      config.runTimeoutMs + config.idleTtlMs + 60_000,
    templateId: config.templateId,
  });
  const capabilityCodec = createRunCapabilityCodec({
    secret: requireSecret(env.BETTER_AUTH_SECRET, "BETTER_AUTH_SECRET"),
  });

  return {
    config,
    runtime,
    service: new RunExecutionService({
      agentRuns: new D1AgentRunRepository(env.DB),
      clock: { now: () => new Date() },
      createId: () => crypto.randomUUID(),
      getAgentRuntime: agentRuntimePolicy.resolve,
      getSandboxRuntime(id: RuntimeKind) {
        if (id !== runtime.kind) {
          throw new Error(`Sandbox runtime is not installed: ${id}`);
        }
        return runtime;
      },
      async issueModelAccess({ expiresAt, issuedAt, run }) {
        return {
          baseUrl: config.modelGatewayBaseUrl,
          bearerToken: await capabilityCodec.issue({
            expiresAt,
            issuedAt,
            maxOutputTokens: config.modelMaxOutputTokens,
            modelId: run.modelId,
            projectId: run.projectId,
            runId: run.id,
          }),
          maxOutputTokens: config.modelMaxOutputTokens,
          modelId: run.modelId,
        };
      },
      messages: new D1MessageRepository(env.DB),
      runTimeoutMs: config.runTimeoutMs,
      sandboxLeases: new D1SandboxLeaseRepository(env.DB),
      workingDirectory: config.workingDirectory,
    }),
  };
}

function requireSecret(value: string | undefined, name: string) {
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}
