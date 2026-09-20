import { createAuthClient } from "better-auth/react";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";

// React UI and Better Auth are served from the same Worker origin.
export const authClient = createAuthClient({ plugins: [oauthProviderClient()] });
