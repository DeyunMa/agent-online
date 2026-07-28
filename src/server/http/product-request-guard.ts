import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { AppEnv } from "../env";
import { modelGatewayEndpointPath } from "../model-gateway-service";
import { renderApiError } from "./api-errors";

export const maximumProductRequestBytes = 256 * 1_024;

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const limitedBody = bodyLimit({
  maxSize: maximumProductRequestBytes,
  onError: (c) => renderApiError(c as Context<AppEnv>, "request.too_large"),
});

/**
 * Guards cookie-authenticated product mutations at the outer HTTP seam.
 * Better Auth and ModelGateway keep their own origin/body protocols.
 */
export function productRequestGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!isProductMutation(c.req.raw)) {
      await next();
      return;
    }

    if (!isSameOriginBrowserRequest(c.req.raw)) {
      return renderApiError(c, "request.forbidden");
    }

    return limitedBody(c, next);
  };
}

function isProductMutation(request: Request) {
  if (safeMethods.has(request.method.toUpperCase())) {
    return false;
  }

  const path = new URL(request.url).pathname;
  return (
    path.startsWith("/api/") &&
    path !== modelGatewayEndpointPath &&
    path !== "/api/auth" &&
    !path.startsWith("/api/auth/")
  );
}

function isSameOriginBrowserRequest(request: Request) {
  const expectedOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).origin === expectedOrigin) {
        return true;
      }
    } catch {
      return false;
    }
  }

  return request.headers.get("sec-fetch-site") === "same-origin";
}
