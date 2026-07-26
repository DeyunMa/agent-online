import type { AgentRunRepository } from "../application/ports";
import { createOpenAiCompatibleModelGateway, type ModelGatewayUsage } from "./model-gateway";
import type { AppBindings } from "./env";
import { D1AgentRunRepository } from "./persistence/d1-repositories";
import { createRunCapabilityCodec } from "./run-capability";

export const modelGatewayEndpointPath = "/api/model-gateway/v1/chat/completions";

export type RunAuthorizedModelGatewayOptions = {
  agentRuns: Pick<AgentRunRepository, "addUsageDelta" | "findById">;
  capabilitySecret: string;
  fetchImplementation?: typeof fetch;
  geminiApiKey: string;
  now?: () => Date;
};

export function createRunAuthorizedModelGateway(options: RunAuthorizedModelGatewayOptions) {
  const capabilityCodec = createRunCapabilityCodec({
    now: options.now,
    secret: options.capabilitySecret,
  });

  return createOpenAiCompatibleModelGateway({
    async authorize(request) {
      const token = readBearerToken(request.headers.get("authorization"));
      if (!token) {
        return null;
      }

      const claims = await capabilityCodec.verify(token);
      if (!claims) {
        return null;
      }

      const run = await options.agentRuns.findById(claims.runId);
      if (
        !run ||
        (run.status !== "starting" && run.status !== "running") ||
        run.projectId !== claims.projectId ||
        run.modelId !== claims.modelId
      ) {
        return null;
      }

      return {
        maxOutputTokens: claims.maxOutputTokens,
        modelId: claims.modelId,
        projectId: claims.projectId,
        runId: claims.runId,
      };
    },
    endpointPath: modelGatewayEndpointPath,
    fetchImplementation: options.fetchImplementation,
    geminiApiKey: options.geminiApiKey,
    onUsage: async (usage, capability) => {
      const updatedRun = await options.agentRuns.addUsageDelta(
        capability.runId,
        toAgentRunUsageDelta(usage),
      );
      if (!updatedRun) {
        throw new Error("AgentRun usage could not be recorded");
      }
    },
  });
}

export function createWorkerModelGateway(env: AppBindings) {
  if (!env.BETTER_AUTH_SECRET || !env.GEMINI_API_KEY) {
    throw new Error("ModelGateway is not configured. Set BETTER_AUTH_SECRET and GEMINI_API_KEY.");
  }

  return createRunAuthorizedModelGateway({
    agentRuns: new D1AgentRunRepository(env.DB),
    capabilitySecret: env.BETTER_AUTH_SECRET,
    geminiApiKey: env.GEMINI_API_KEY,
  });
}

function readBearerToken(authorization: string | null) {
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i);
  return match?.[1] ?? null;
}

function toAgentRunUsageDelta(usage: ModelGatewayUsage) {
  return {
    inputTokens: usage.inputTokens,
    modelRequestCount: usage.modelRequestCount,
    outputTokens: usage.outputTokens,
    sandboxDurationMs: 0,
    totalTokens: usage.totalTokens,
  };
}
