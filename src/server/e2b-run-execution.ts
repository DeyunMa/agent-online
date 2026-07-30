import { RunExecutionService } from "../application/run-execution";
import { SandboxReclaimer } from "../application/sandbox-reclaimer";
import type { E2BSandboxRuntime } from "../runtime/e2b-runtime";
import type { RuntimeKind } from "../runtime/contract";
import type { DiagnosticContext } from "../observability/contract";
import type { AppBindings } from "./env";
import { getAgentRuntimePolicy } from "./agent-runtime-policy";
import {
  D1AgentRunRepository,
  D1MessageRepository,
  D1SandboxLeaseRepository,
} from "./persistence/d1-repositories";
import { createE2BSandboxRuntime } from "./e2b-runtime-factory";
import { createRunCapabilityCodec } from "./run-capability";
import type { E2BExecutionConfig } from "./runtime-config";
import { createDiagnosticReporter } from "./observability/reporter";

export type E2BRunExecution = {
  config: E2BExecutionConfig;
  runtime: E2BSandboxRuntime;
  service: RunExecutionService;
};

export function createE2BRunExecution(
  env: AppBindings,
  diagnosticContext: DiagnosticContext = {},
): E2BRunExecution {
  const { config, runtime } = createE2BSandboxRuntime(env);
  const agentRuntimePolicy = getAgentRuntimePolicy(env, "e2b");
  const capabilityCodec = createRunCapabilityCodec({
    secret: requireSecret(env.BETTER_AUTH_SECRET, "BETTER_AUTH_SECRET"),
  });
  const agentRuns = new D1AgentRunRepository(env.DB);
  const clock = { now: () => new Date() };
  const diagnostics = createDiagnosticReporter(diagnosticContext);
  const sandboxLeases = new D1SandboxLeaseRepository(env.DB);
  const getSandboxRuntime = (id: RuntimeKind) => {
    if (id !== runtime.kind) {
      throw new Error(`Sandbox runtime is not installed: ${id}`);
    }
    return runtime;
  };

  return {
    config,
    runtime,
    service: new RunExecutionService({
      agentRuns,
      clock,
      createId: () => crypto.randomUUID(),
      diagnostics,
      getAgentRuntime: agentRuntimePolicy.resolve,
      getSandboxRuntime,
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
      sandboxReclaimer: new SandboxReclaimer({
        agentRuns,
        clock,
        diagnostics,
        getSandboxRuntime,
        sandboxLeases,
      }),
      sandboxLeases,
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
