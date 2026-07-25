import { betterAuth } from "better-auth";

import { getAuthConfig } from "./config";
import type { AppBindings } from "./env";

export function createAuth(env: AppBindings) {
  const config = getAuthConfig(env);

  return betterAuth({
    baseURL: config.baseURL,
    database: env.DB,
    emailAndPassword: {
      enabled: true,
    },
    secret: config.secret,
    trustedOrigins: [config.baseURL],
  });
}
