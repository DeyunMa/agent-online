import type { Context } from "hono";

import type { ApiErrorResponse } from "../../shared/api";
import type { PublicErrorCode } from "../../shared/error-codes";
import type { AppEnv } from "../env";

type PublicErrorDefinition = {
  retryable: boolean;
  status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 500 | 503;
};

export const publicErrorDefinitions = {
  "agent_runtime.unavailable": { retryable: false, status: 409 },
  "auth.unauthorized": { retryable: false, status: 401 },
  "file.already_exists": { retryable: false, status: 409 },
  "file.content_unsupported": { retryable: false, status: 415 },
  "file.too_large": { retryable: false, status: 413 },
  "internal.unexpected": { retryable: true, status: 500 },
  "preview.dependencies_missing": { retryable: false, status: 409 },
  "preview.entry_missing": { retryable: false, status: 409 },
  "preview.unavailable": { retryable: true, status: 503 },
  "project.busy": { retryable: true, status: 409 },
  "project_path.not_found": { retryable: false, status: 404 },
  "project_path.unsupported": { retryable: false, status: 400 },
  "request.forbidden": { retryable: false, status: 403 },
  "request.invalid": { retryable: false, status: 400 },
  "request.too_large": { retryable: false, status: 413 },
  "resource.not_found": { retryable: false, status: 404 },
  "run.creation_disabled": { retryable: false, status: 503 },
  "sandbox.not_active": { retryable: false, status: 409 },
  "sandbox.provider_unavailable": { retryable: true, status: 503 },
  "service.unavailable": { retryable: true, status: 503 },
} as const satisfies Record<PublicErrorCode, PublicErrorDefinition>;

export function renderApiError(c: Context<AppEnv>, code: PublicErrorCode) {
  const definition = publicErrorDefinitions[code];
  const requestId = c.get("requestId") || crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("x-request-id", requestId);

  return c.json<ApiErrorResponse>(
    {
      error: {
        code,
        retryable: definition.retryable,
      },
      requestId,
    },
    definition.status,
  );
}
