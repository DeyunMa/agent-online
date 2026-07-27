import { Hono } from "hono";
import type { WSEvents, WSContext } from "hono/ws";
import { describe, expect, it, vi } from "vitest";

import type { ProjectTerminalConnection } from "../application/project-terminal";
import type { ProjectRecord } from "../application/ports";
import type { AppEnv } from "./env";
import { createTerminalApi, type TerminalApiDependencies } from "./terminal-api";
import type { ServerServices } from "./services";

const user = { email: "user@example.test", id: "user-1" };
const project: ProjectRecord = {
  createdAt: "2026-07-26T08:00:00.000Z",
  defaultAgentRuntimeId: "pi",
  id: "project-1",
  title: "Terminal project",
  updatedAt: "2026-07-26T08:00:00.000Z",
  userId: user.id,
};

describe("Terminal API", () => {
  it("authenticates before upgrading and relays only the normalized Terminal protocol", async () => {
    const connection = createConnection();
    const fixture = createFixture({
      openResult: { connection, kind: "opened" },
    });
    const response = await fixture.request();

    expect(response.status).toBe(200);
    const socket = createSocket();
    fixture.events?.onMessage?.(
      messageEvent(
        JSON.stringify({
          cols: 100,
          rows: 30,
          type: "attach",
        }),
      ),
      socket.context,
    );

    await vi.waitFor(() => {
      expect(socket.close).toHaveBeenCalledWith(1000, "terminal_exited");
    });
    expect(fixture.open).toHaveBeenCalledWith("project-1", {
      cols: 100,
      rows: 30,
    });
    expect(socket.sent).toHaveLength(3);
    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      expiresAt: "2026-07-26T08:30:00.000Z",
      type: "ready",
    });
    expect(socket.sent[1]).toEqual(new TextEncoder().encode("terminal output"));
    expect(JSON.parse(socket.sent[2] as string)).toEqual({
      exitCode: 0,
      type: "closed",
    });
    expect(JSON.stringify(socket.sent)).not.toContain("sandbox-provider");
    expect(JSON.stringify(socket.sent)).not.toContain("9001");
  });

  it("returns a normalized project_busy control error after upgrade", async () => {
    const fixture = createFixture({
      openResult: { kind: "project_busy" },
    });
    await fixture.request();
    const socket = createSocket();

    fixture.events?.onMessage?.(
      messageEvent(
        JSON.stringify({
          cols: 80,
          rows: 24,
          type: "attach",
        }),
      ),
      socket.context,
    );

    await vi.waitFor(() => {
      expect(socket.close).toHaveBeenCalledWith(1008, "project_busy");
    });
    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      code: "project_busy",
      type: "error",
    });
  });

  it("rejects malformed messages and never starts a Terminal", async () => {
    const fixture = createFixture({
      openResult: { kind: "project_busy" },
    });
    await fixture.request();
    const socket = createSocket();

    fixture.events?.onMessage?.(
      messageEvent('{"type":"input","data":"before attach"}'),
      socket.context,
    );

    await vi.waitFor(() => {
      expect(socket.close).toHaveBeenCalledWith(1008, "invalid_message");
    });
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it("rejects oversized raw frames before JSON parsing", async () => {
    const fixture = createFixture({
      openResult: { kind: "project_busy" },
    });
    await fixture.request();
    const socket = createSocket();

    fixture.events?.onMessage?.(
      messageEvent(`{"type":"input","data":"${"x".repeat(20_000)}"}`),
      socket.context,
    );

    await vi.waitFor(() => {
      expect(socket.close).toHaveBeenCalledWith(1008, "invalid_message");
    });
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it("closes a socket that never sends its attach message", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createFixture({
        openResult: { kind: "project_busy" },
      });
      await fixture.request();
      const socket = createSocket();
      fixture.events?.onOpen?.({} as Event, socket.context);

      await vi.advanceTimersByTimeAsync(10_000);

      expect(socket.close).toHaveBeenCalledWith(1008, "invalid_message");
      expect(fixture.open).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects unauthenticated and cross-origin handshakes before opening provider state", async () => {
    const unauthenticated = createFixture({
      authenticated: false,
      openResult: { kind: "project_busy" },
    });
    const crossOrigin = createFixture({
      openResult: { kind: "project_busy" },
      origin: "https://attacker.example",
    });

    const unauthenticatedResponse = await unauthenticated.request();
    const crossOriginResponse = await crossOrigin.request();

    expect(unauthenticatedResponse.status).toBe(401);
    expect(crossOriginResponse.status).toBe(403);
    expect(unauthenticated.upgrade).not.toHaveBeenCalled();
    expect(crossOrigin.upgrade).not.toHaveBeenCalled();
  });

  it("closes the provider PTY when the browser disconnects", async () => {
    const connection = createConnection(true);
    const fixture = createFixture({
      openResult: { connection, kind: "opened" },
    });
    await fixture.request();
    const socket = createSocket();
    fixture.events?.onMessage?.(
      messageEvent(
        JSON.stringify({
          cols: 80,
          rows: 24,
          type: "attach",
        }),
      ),
      socket.context,
    );
    await vi.waitFor(() => {
      expect(fixture.open).toHaveBeenCalled();
    });

    fixture.events?.onClose?.({} as CloseEvent, socket.context);

    await vi.waitFor(() => {
      expect(connection.close).toHaveBeenCalledWith("client_closed");
    });
  });
});

function createFixture(options: {
  authenticated?: boolean;
  openResult: Awaited<ReturnType<ServerServices["projectTerminals"]["open"]>>;
  origin?: string;
}) {
  let events: WSEvents<WebSocket> | null = null;
  const open = vi.fn(async () => options.openResult);
  const upgrade = vi.fn<TerminalApiDependencies["upgrade"]>(async (_context, nextEvents) => {
    events = nextEvents;
    return new Response(null, { status: 200 });
  });
  const services = {
    projectTerminals: { open },
    projects: {
      findOwnedById: vi.fn(async () => project),
    },
  } as unknown as ServerServices;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "request-1");
    await next();
  });
  app.route(
    "/api",
    createTerminalApi({
      createServices: () => services,
      getAuthenticatedUser: async () => (options.authenticated === false ? null : user),
      upgrade,
    }),
  );

  return {
    get events() {
      return events;
    },
    open,
    request: () =>
      app.request("https://agent-online.test/api/projects/project-1/terminal", {
        headers: {
          origin: options.origin ?? "https://agent-online.test",
          upgrade: "websocket",
        },
      }),
    upgrade,
  };
}

function createConnection(keepOpen = false) {
  const close = vi.fn(async () => undefined);
  const connection: ProjectTerminalConnection = {
    close,
    expiresAt: "2026-07-26T08:30:00.000Z",
    async *events() {
      if (keepOpen) {
        await new Promise<void>(() => undefined);
        return;
      }
      yield {
        chunk: new TextEncoder().encode("terminal output"),
        sandboxLeaseId: "lease-private",
        type: "terminal.output" as const,
      };
      yield {
        exitCode: 0,
        sandboxLeaseId: "lease-private",
        type: "terminal.exited" as const,
      };
    },
    resize: vi.fn(async () => undefined),
    write: vi.fn(async () => undefined),
  };
  return connection;
}

function createSocket() {
  const sent: Array<string | Uint8Array> = [];
  const close = vi.fn();
  const context = {
    close,
    readyState: 1,
    send: (data: string | ArrayBuffer | Uint8Array) => {
      if (data instanceof ArrayBuffer) {
        sent.push(new Uint8Array(data));
      } else {
        sent.push(data);
      }
    },
  } as unknown as WSContext<WebSocket>;

  return { close, context, sent };
}

function messageEvent(data: string) {
  return { data } as MessageEvent;
}
