import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

import { getAuthConfig } from "./config";
import { getDeploymentPolicy, isEmailAllowed } from "./deployment-policy";
import type { AppBindings } from "./env";

export function createAuth(env: AppBindings) {
  const config = getAuthConfig(env);
  const deploymentPolicy = getDeploymentPolicy(env);

  return betterAuth({
    baseURL: config.baseURL,
    database: env.DB,
    emailAndPassword: {
      enabled: true,
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (context.path !== "/sign-up/email" && context.path !== "/sign-in/email") {
          return;
        }

        const email = typeof context.body?.email === "string" ? context.body.email : null;
        if (email && !isEmailAllowed(deploymentPolicy, email)) {
          throw new APIError("FORBIDDEN", {
            message: "This deployment is invite-only.",
          });
        }
      }),
    },
    secret: config.secret,
    trustedOrigins: [config.baseURL],
  });
}
