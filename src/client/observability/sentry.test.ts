import type { ErrorEvent } from "@sentry/react";
import { describe, expect, it } from "vitest";

import { sanitizeClientSentryEvent } from "./sentry";

describe("client Sentry adapter", () => {
  it("keeps a useful stack while removing browser and user content", () => {
    const sanitized = sanitizeClientSentryEvent({
      breadcrumbs: [{ message: "private interaction" }],
      contexts: { browser: { name: "private browser context" } },
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                {
                  filename: "assets/index.js",
                  lineno: 7,
                  vars: { message: "private message" },
                },
              ],
            },
            type: "RenderError",
            value: "private rendered content",
          },
        ],
      },
      extra: { project: "private project" },
      request: {
        cookies: { session: "private cookie" },
        headers: { authorization: "private token" },
      },
      type: undefined,
      user: { email: "private@example.test" },
    } as ErrorEvent);

    expect(sanitized).toMatchObject({
      exception: {
        values: [
          {
            stacktrace: {
              frames: [{ filename: "assets/index.js", lineno: 7 }],
            },
            type: "RenderError",
            value: "Client application exception",
          },
        ],
      },
      logger: "agent-online-client",
      message: "Agent Online client error",
      type: undefined,
    });
    expect(JSON.stringify(sanitized)).not.toMatch(
      /authorization|cookie|private|rendered content|session/i,
    );
    expect(sanitized.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars).toBeUndefined();
  });
});
