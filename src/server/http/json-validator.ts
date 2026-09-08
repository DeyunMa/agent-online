import { type Hook, zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";

import type { AppEnv } from "../env";
import { renderApiError } from "./api-errors";

/** Keep Hono's JSON parser and Zod failures inside the public, content-free error contract. */
export function validateJsonRequest<T extends z.ZodType>(schema: T) {
  const hook: Hook<z.output<T>, AppEnv, string, "json", object, T> = (result, c) => {
    if (!result.success) {
      return renderApiError(c, "request.invalid");
    }
  };
  const validator = zValidator<T, "json", AppEnv, string, typeof hook>("json", schema, hook);

  const middleware: typeof validator = async (c, next) => {
    let response: Awaited<ReturnType<typeof validator>>;
    try {
      // Run validation before the route handler so a downstream error is never
      // mistaken for a malformed request. Hono stores parsed data in req.valid().
      response = await validator(c, async () => undefined);
    } catch (error) {
      if (error instanceof HTTPException && error.status === 400) {
        return renderApiError(c, "request.invalid");
      }
      throw error;
    }
    if (response) {
      return response;
    }
    await next();
  };

  return middleware;
}
