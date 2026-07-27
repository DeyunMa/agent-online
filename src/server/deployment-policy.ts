import type { AppBindings } from "./env";

export type DeploymentPolicy = {
  accessMode: "allowlist" | "open";
  allowedEmails: ReadonlySet<string> | null;
  runsEnabled: boolean;
};

export function getDeploymentPolicy(
  env: Pick<AppBindings, "ACCESS_ALLOWED_EMAILS" | "ACCESS_MODE" | "RUNS_ENABLED">,
): DeploymentPolicy {
  const accessMode = parseAccessMode(env.ACCESS_MODE, env.ACCESS_ALLOWED_EMAILS);

  return {
    accessMode,
    allowedEmails:
      accessMode === "allowlist" ? parseAllowedEmails(env.ACCESS_ALLOWED_EMAILS) : null,
    runsEnabled: parseBoolean(env.RUNS_ENABLED, true, "RUNS_ENABLED"),
  };
}

export function isEmailAllowed(policy: DeploymentPolicy, email: string): boolean {
  return policy.allowedEmails === null || policy.allowedEmails.has(normalizeEmail(email));
}

function parseAllowedEmails(value: string | undefined) {
  const emails = (value ?? "").split(",").map(normalizeEmail).filter(Boolean);
  if (emails.length === 0) {
    throw new Error("ACCESS_ALLOWED_EMAILS must contain at least one email when set");
  }

  return new Set(emails);
}

function parseAccessMode(
  value: string | undefined,
  allowedEmails: string | undefined,
): DeploymentPolicy["accessMode"] {
  if (value === undefined || value.trim() === "") {
    return allowedEmails === undefined ? "open" : "allowlist";
  }

  const normalized = value.trim().toLocaleLowerCase();
  if (normalized === "open" || normalized === "allowlist") {
    return normalized;
  }

  throw new Error("ACCESS_MODE must be open or allowlist");
}

function normalizeEmail(value: string) {
  return value.trim().toLocaleLowerCase();
}

function parseBoolean(value: string | undefined, defaultValue: boolean, name: string) {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  const normalized = value.trim().toLocaleLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }

  throw new Error(`${name} must be true or false`);
}
