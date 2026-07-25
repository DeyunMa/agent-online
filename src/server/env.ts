export interface AppBindings {
  ASSETS: Fetcher;
  ADMIN_EMAILS?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  DB: D1Database;
  E2B_API_KEY?: string;
  GEMINI_API_KEY?: string;
}

export interface AppVariables {
  requestId: string;
}

export type AppEnv = {
  Bindings: AppBindings;
  Variables: AppVariables;
};
