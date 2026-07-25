export interface AppBindings {
  ASSETS: Fetcher;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  DB: D1Database;
  GEMINI_API_KEY?: string;
  PROJECT_BUCKET: R2Bucket;
}

export interface AppVariables {
  requestId: string;
}

export type AppEnv = {
  Bindings: AppBindings;
  Variables: AppVariables;
};
