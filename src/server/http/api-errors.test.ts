import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { publicErrorCodes } from "../../shared/error-codes";
import type { AppEnv } from "../env";
import { publicErrorDefinitions, renderApiError } from "./api-errors";

describe("API error renderer", () => {
  it("defines one transport mapping for every public error code", () => {
    expect(Object.keys(publicErrorDefinitions).sort()).toEqual([...publicErrorCodes].sort());
  });

  it.each(publicErrorCodes)("renders %s with a matching request ID", async (code) => {
    const app = new Hono<AppEnv>();
    app.get("/", (c) => {
      c.set("requestId", "request-1");
      return renderApiError(c, code);
    });

    const response = await app.request("https://agent-online.test/");

    expect(response.status).toBe(publicErrorDefinitions[code].status);
    expect(response.headers.get("x-request-id")).toBe("request-1");
    await expect(response.json()).resolves.toEqual({
      error: {
        code,
        retryable: publicErrorDefinitions[code].retryable,
      },
      requestId: "request-1",
    });
  });
});
