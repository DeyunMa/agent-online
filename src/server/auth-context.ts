import { createAuth } from "./auth";
import type { AppBindings } from "./env";

export type AuthenticatedUser = {
  email: string;
  id: string;
};

/**
 * Resolves the Better Auth session once at the trusted HTTP boundary.
 * Application routes must derive ownership from this value, never request input.
 */
export async function getAuthenticatedUser(
  env: AppBindings,
  headers: Headers,
): Promise<AuthenticatedUser | null> {
  const session = await createAuth(env).api.getSession({ headers });

  if (!session) {
    return null;
  }

  return {
    email: session.user.email,
    id: session.user.id,
  };
}
