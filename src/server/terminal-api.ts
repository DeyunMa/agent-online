import { Hono, type Context } from "hono";
import { WSContext, type WSEvents } from "hono/ws";
import { z } from "zod";

import type { ProjectTerminalConnection } from "../application/project-terminal";
import { maxTerminalInputBytes } from "../application/project-terminal";
import type { DiagnosticContext } from "../observability/contract";
import type {
  TerminalClientMessage,
  TerminalServerErrorCode,
  TerminalServerMessage,
} from "../shared/terminal";
import { getAuthenticatedUser, type AuthenticatedUser } from "./auth-context";
import type { AppBindings, AppEnv } from "./env";
import { renderApiError } from "./http/api-errors";
import { createServerServices, type ServerServices } from "./services";

const terminalClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    cols: z.number().int(),
    rows: z.number().int(),
    type: z.literal("attach"),
  }),
  z.object({
    data: z.string().min(1).max(maxTerminalInputBytes),
    type: z.literal("input"),
  }),
  z.object({
    cols: z.number().int(),
    rows: z.number().int(),
    type: z.literal("resize"),
  }),
  z.object({ type: z.literal("close") }),
]);
const terminalAttachTimeoutMs = 10_000;
const maxQueuedTerminalMessages = 32;
const maxTerminalFrameBytes = maxTerminalInputBytes + 1_024;

type AppContext = Context<AppEnv>;

type TerminalWebSocketUpgrade = (c: AppContext, events: WSEvents<WebSocket>) => Promise<Response>;

export type TerminalApiDependencies = {
  createServices(env: AppBindings, diagnosticContext?: DiagnosticContext): ServerServices;
  getAuthenticatedUser(env: AppBindings, headers: Headers): Promise<AuthenticatedUser | null>;
  upgrade: TerminalWebSocketUpgrade;
};

const defaultDependencies: TerminalApiDependencies = {
  createServices: createServerServices,
  getAuthenticatedUser,
  upgrade: upgradeCloudflareWebSocket,
};

export function createTerminalApi(overrides: Partial<TerminalApiDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  const api = new Hono<AppEnv>();

  api.get("/projects/:projectId/terminal", async (c) => {
    const user = await dependencies.getAuthenticatedUser(c.env, c.req.raw.headers);
    if (!user) {
      return renderApiError(c, "auth.unauthorized");
    }
    if (!isSameOriginWebSocket(c.req.raw)) {
      return renderApiError(c, "request.forbidden");
    }

    const services = dependencies.createServices(c.env, {
      requestId: c.get("requestId"),
    });
    const project = await services.projects.findOwnedById(c.req.param("projectId"), user.id);
    if (!project) {
      return renderApiError(c, "resource.not_found");
    }

    return dependencies.upgrade(
      c,
      createTerminalSocketEvents(services.projectTerminals, project.id, getWaitUntil(c)),
    );
  });

  return api;
}

async function upgradeCloudflareWebSocket(c: AppContext, events: WSEvents<WebSocket>) {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response(null, { status: 426 });
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  const ws = new WSContext<WebSocket>({
    close: (code, reason) => server.close(code, reason),
    get protocol() {
      return server.protocol;
    },
    raw: server,
    get readyState() {
      return server.readyState as 0 | 1 | 2 | 3;
    },
    send: (source) => server.send(source),
    url: server.url ? new URL(server.url) : null,
  });

  if (events.onClose) {
    server.addEventListener("close", (event) => events.onClose?.(event, ws));
  }
  if (events.onMessage) {
    server.addEventListener("message", (event) => events.onMessage?.(event, ws));
  }
  if (events.onError) {
    server.addEventListener("error", (event) => events.onError?.(event, ws));
  }
  server.accept();
  events.onOpen?.(new Event("open"), ws);

  return new Response(null, {
    status: 101,
    webSocket: client,
  } as ResponseInit & { webSocket: WebSocket });
}

function getWaitUntil(c: AppContext) {
  try {
    const executionCtx = c.executionCtx;
    return (promise: Promise<unknown>) => executionCtx.waitUntil(promise);
  } catch {
    // Hono's isolated unit-test request helper has no ExecutionContext.
    return (_promise: Promise<unknown>) => undefined;
  }
}

function createTerminalSocketEvents(
  projectTerminals: ServerServices["projectTerminals"],
  projectId: string,
  waitUntil: (promise: Promise<unknown>) => void,
): WSEvents<WebSocket> {
  let attachTimer: ReturnType<typeof setTimeout> | null = null;
  let connection: ProjectTerminalConnection | null = null;
  let opening = false;
  let queuedOperations = 0;
  let socketClosed = false;
  let operations = Promise.resolve();

  const schedule = (operation: Promise<unknown>) => {
    waitUntil(operation.catch(() => undefined));
  };
  const clearAttachTimer = () => {
    if (attachTimer) {
      clearTimeout(attachTimer);
      attachTimer = null;
    }
  };
  const closeConnection = (reason: "client_closed" | "failed") => {
    if (connection) {
      return connection.close(reason);
    }
    return Promise.resolve();
  };

  const failSocket = async (
    ws: WSContext<WebSocket>,
    code: TerminalServerErrorCode,
    closeCode = 1008,
  ) => {
    clearAttachTimer();
    sendControlBestEffort(ws, { code, type: "error" });
    socketClosed = true;
    await closeConnection(code === "provider_error" ? "failed" : "client_closed");
    closeSocketBestEffort(ws, closeCode, code);
  };

  const handleMessage = async (raw: MessageEvent["data"], ws: WSContext<WebSocket>) => {
    const message = parseTerminalClientMessage(raw);
    if (!message) {
      await failSocket(ws, "invalid_message");
      return;
    }

    if (message.type === "attach") {
      if (opening || connection) {
        await failSocket(ws, "invalid_message");
        return;
      }

      clearAttachTimer();
      opening = true;
      const opened = await projectTerminals.open(projectId, {
        cols: message.cols,
        rows: message.rows,
      });
      opening = false;

      if (opened.kind !== "opened") {
        await failSocket(ws, toTerminalErrorCode(opened.kind));
        return;
      }

      connection = opened.connection;
      if (socketClosed) {
        await connection.close("client_closed");
        return;
      }

      sendControlBestEffort(ws, {
        expiresAt: connection.expiresAt,
        type: "ready",
      });
      void pumpTerminalEvents(connection, ws).catch(async () => {
        await failSocket(ws, "provider_error", 1011);
      });
      return;
    }

    if (!connection) {
      await failSocket(ws, "invalid_message");
      return;
    }

    if (message.type === "input") {
      await connection.write(new TextEncoder().encode(message.data));
      return;
    }
    if (message.type === "resize") {
      await connection.resize({
        cols: message.cols,
        rows: message.rows,
      });
      return;
    }

    socketClosed = true;
    await connection.close("client_closed");
    closeSocketBestEffort(ws, 1000, "client_closed");
  };

  return {
    onOpen(_event, ws) {
      attachTimer = setTimeout(() => {
        if (opening || connection || socketClosed) {
          return;
        }
        socketClosed = true;
        schedule(failSocket(ws, "invalid_message"));
      }, terminalAttachTimeoutMs);
    },
    onClose() {
      clearAttachTimer();
      socketClosed = true;
      operations = operations.then(() => closeConnection("client_closed")).catch(() => undefined);
      schedule(operations);
    },
    onError() {
      clearAttachTimer();
      socketClosed = true;
      operations = operations.then(() => closeConnection("failed")).catch(() => undefined);
      schedule(operations);
    },
    onMessage(event, ws) {
      if (socketClosed) {
        return;
      }
      if (queuedOperations >= maxQueuedTerminalMessages) {
        socketClosed = true;
        schedule(failSocket(ws, "invalid_message"));
        return;
      }

      queuedOperations += 1;
      const operation = operations
        .then(() => handleMessage(event.data, ws))
        .catch(() => failSocket(ws, "provider_error", 1011))
        .finally(() => {
          queuedOperations -= 1;
        });
      operations = operation.catch(() => undefined);
      schedule(operation);
    },
  };
}

async function pumpTerminalEvents(connection: ProjectTerminalConnection, ws: WSContext<WebSocket>) {
  for await (const event of connection.events()) {
    if (event.type === "terminal.output") {
      const output = new Uint8Array(event.chunk.byteLength);
      output.set(event.chunk);
      ws.send(output);
      continue;
    }

    sendControlBestEffort(ws, {
      exitCode: event.exitCode,
      type: "closed",
    });
    closeSocketBestEffort(ws, 1000, "terminal_exited");
  }
}

function parseTerminalClientMessage(raw: MessageEvent["data"]): TerminalClientMessage | null {
  if (typeof raw !== "string") {
    return null;
  }
  if (new TextEncoder().encode(raw).byteLength > maxTerminalFrameBytes) {
    return null;
  }

  try {
    const parsed = terminalClientMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function toTerminalErrorCode(
  kind:
    | "invalid_size"
    | "project_busy"
    | "provider_error"
    | "runtime_mismatch"
    | "sandbox_unavailable",
): TerminalServerErrorCode {
  switch (kind) {
    case "project_busy":
      return "project_busy";
    case "provider_error":
      return "provider_error";
    case "runtime_mismatch":
    case "sandbox_unavailable":
      return "sandbox_unavailable";
    case "invalid_size":
      return "invalid_message";
  }
}

function sendControlBestEffort(ws: WSContext<WebSocket>, message: TerminalServerMessage) {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // The browser may already have closed the WebSocket.
  }
}

function closeSocketBestEffort(ws: WSContext<WebSocket>, code: number, reason: string) {
  try {
    ws.close(code, reason);
  } catch {
    // The browser may already have closed the WebSocket.
  }
}

function isSameOriginWebSocket(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) {
    return false;
  }

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
