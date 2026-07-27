import { Hono, type Context } from "hono";

import { UserUsageService, type UserUsageQuery } from "../application/user-usage";
import type { UserUsageResponse } from "../shared/api";
import { getAuthenticatedUser, type AuthenticatedUser } from "./auth-context";
import type { AppBindings, AppEnv } from "./env";
import { renderApiError } from "./http/api-errors";
import { D1UserUsageRepository } from "./persistence/d1-repositories";

type AppContext = Context<AppEnv>;

export type UsageApiDependencies = {
  createUsageQuery: (env: AppBindings) => UserUsageQuery;
  getAuthenticatedUser: (env: AppBindings, headers: Headers) => Promise<AuthenticatedUser | null>;
};

const defaultDependencies: UsageApiDependencies = {
  createUsageQuery: (env) => new UserUsageService(new D1UserUsageRepository(env.DB)),
  getAuthenticatedUser,
};

export function createUsageApi(overrides: Partial<UsageApiDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  const api = new Hono<AppEnv>();

  api.get("/usage", async (c) => {
    const user = await dependencies.getAuthenticatedUser(c.env, c.req.raw.headers);
    if (!user) {
      return unauthorized(c);
    }

    const summary = await dependencies.createUsageQuery(c.env).getForUser(user.id);

    return c.json<UserUsageResponse>({
      ...summary,
      scope: "all_time",
    });
  });

  return api;
}

function unauthorized(c: AppContext) {
  return renderApiError(c, "auth.unauthorized");
}
