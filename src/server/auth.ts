import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { getAuthConfig } from "./config";
import { getDeploymentPolicy, isEmailAllowed } from "./deployment-policy";
import type { AppBindings } from "./env";
import { getCimdPlugin } from "./mcp/cimd";

export function createAuth(env: AppBindings) {
  const config = getAuthConfig(env);
  const deploymentPolicy = getDeploymentPolicy(env);

  const provider = oauthProvider({
    loginPage: "/mcp/authorize",
    consentPage: "/mcp/authorize",
    scopes: ["insights:read", "offline_access"],
    resources: [
      {
        identifier: `${new URL(config.baseURL).origin}/mcp`,
        name: "Agent Online insights",
        accessTokenTtl: 300,
        allowedScopes: ["insights:read", "offline_access"],
      },
    ],
    enforcePerClientResources: false,
    clientRegistrationDefaultResources: [`${new URL(config.baseURL).origin}/mcp`],
    grantTypes: ["authorization_code", "refresh_token"],
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    accessTokenExpiresIn: 300,
    codeExpiresIn: 300,
  });

  return betterAuth({
    baseURL: config.baseURL,
    database: env.DB,
    logger: { disabled: true },
    disabledPaths: ["/token"],
    plugins: [
      jwt(),
      // 1.7.5's OpenAPI metadata declaration conflicts with exactOptionalPropertyTypes.
      // Narrow only the documentation metadata; retain every inferred endpoint signature.
      provider as typeof provider & {
        endpoints: { oauth2Authorize: { options: { metadata: never } } };
      },
      getCimdPlugin(env.DB, new URL(config.baseURL).origin),
    ],
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
