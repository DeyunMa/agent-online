import { createAuthClient } from "better-auth/react";

// React UI and Better Auth are served from the same Worker origin.
export const authClient = createAuthClient();
