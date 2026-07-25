import type { AppBindings } from "./env";

export function getAuthConfig(env: AppBindings) {
  if (!env.BETTER_AUTH_SECRET || !env.BETTER_AUTH_URL) {
    throw new Error("Better Auth is not configured. Set BETTER_AUTH_SECRET and BETTER_AUTH_URL.");
  }

  return {
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
  };
}
