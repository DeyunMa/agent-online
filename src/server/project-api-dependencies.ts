import { getAuthenticatedUser, type AuthenticatedUser } from "./auth-context";
import { getDeploymentPolicy, type DeploymentPolicy } from "./deployment-policy";
import type { AppBindings } from "./env";
import { createServerServices, type ServerServices } from "./services";

export type ProjectApiDependencies = {
  createId(): string;
  createServices(env: AppBindings): ServerServices;
  getAuthenticatedUser(env: AppBindings, headers: Headers): Promise<AuthenticatedUser | null>;
  getDeploymentPolicy(env: AppBindings): DeploymentPolicy;
  now(): Date;
};

const defaultDependencies: ProjectApiDependencies = {
  createId: () => crypto.randomUUID(),
  createServices: createServerServices,
  getAuthenticatedUser,
  getDeploymentPolicy,
  now: () => new Date(),
};

export function resolveProjectApiDependencies(
  overrides: Partial<ProjectApiDependencies>,
): ProjectApiDependencies {
  return { ...defaultDependencies, ...overrides };
}
