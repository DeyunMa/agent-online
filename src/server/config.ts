import { z } from "zod";

import { defaultAgentRuntimeId } from "../agent/registry";
import type { AppBindings } from "./env";

const publicConfigSchema = z.object({
  defaultAgentRuntime: z.literal(defaultAgentRuntimeId),
  maxActiveSandboxesPerUser: z.literal(1),
  maxRunWallSeconds: z.number().int().positive(),
  runtimeIdleTtlSeconds: z.number().int().positive(),
  runtimeProvider: z.enum(["fake", "e2b", "cloudflare-container"]),
});

export type PublicRuntimeConfig = z.infer<typeof publicConfigSchema>;

export const publicRuntimeConfig = publicConfigSchema.parse({
  defaultAgentRuntime: defaultAgentRuntimeId,
  maxActiveSandboxesPerUser: 1,
  maxRunWallSeconds: 1_800,
  runtimeIdleTtlSeconds: 600,
  runtimeProvider: "fake",
});

export function getAuthConfig(env: AppBindings) {
  if (!env.BETTER_AUTH_SECRET || !env.BETTER_AUTH_URL) {
    throw new Error("Better Auth is not configured. Set BETTER_AUTH_SECRET and BETTER_AUTH_URL.");
  }

  return {
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
  };
}
