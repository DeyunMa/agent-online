import type {
  TerminalClientMessage,
  TerminalServerErrorCode,
  TerminalServerMessage,
} from "../shared/terminal";

export class BrowserTerminalError extends Error {
  constructor(readonly code: TerminalServerErrorCode | "network_error") {
    super(messageForTerminalError(code));
    this.name = "BrowserTerminalError";
  }
}

export type BrowserTerminalHandlers = {
  onClose(): void;
  onData(data: Uint8Array): void;
  onError(error: BrowserTerminalError): void;
  onExit(exitCode: number): void;
  onReady(expiresAt: string): void;
};

export interface BrowserTerminalConnection {
  close(): void;
  dispose(): void;
  resize(cols: number, rows: number): void;
  write(data: string): void;
}

export function connectProjectTerminal(
  projectId: string,
  size: { cols: number; rows: number },
  handlers: BrowserTerminalHandlers,
): BrowserTerminalConnection {
  const socket = new WebSocket(projectTerminalUrl(projectId));
  socket.binaryType = "arraybuffer";
  let deliberateClose = false;
  let errorReported = false;
  let forceCloseTimer: ReturnType<typeof setTimeout> | null = null;
  let ready = false;
  let serverClosed = false;

  const clearForceCloseTimer = () => {
    if (forceCloseTimer) {
      clearTimeout(forceCloseTimer);
      forceCloseTimer = null;
    }
  };
  const forceCloseAfterGracePeriod = () => {
    if (forceCloseTimer || socket.readyState === WebSocket.CLOSED) {
      return;
    }
    forceCloseTimer = setTimeout(() => {
      forceCloseTimer = null;
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
      }
    }, 5_000);
  };
  const reportError = (
    code: TerminalServerErrorCode | "network_error",
  ) => {
    if (errorReported || deliberateClose || serverClosed) {
      return;
    }
    errorReported = true;
    handlers.onError(new BrowserTerminalError(code));
    forceCloseAfterGracePeriod();
  };

  socket.addEventListener("open", () => {
    sendMessage(socket, {
      cols: size.cols,
      rows: size.rows,
      type: "attach",
    });
  });

  socket.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) {
      handlers.onData(new Uint8Array(event.data));
      return;
    }
    if (typeof event.data !== "string") {
      reportError("network_error");
      return;
    }

    const message = parseTerminalServerMessage(event.data);
    if (!message) {
      reportError("network_error");
      return;
    }
    if (message.type === "ready") {
      ready = true;
      handlers.onReady(message.expiresAt);
      return;
    }
    if (message.type === "error") {
      reportError(message.code);
      return;
    }

    serverClosed = true;
    handlers.onExit(message.exitCode);
    forceCloseAfterGracePeriod();
  });

  socket.addEventListener("error", () => {
    reportError("network_error");
  });
  socket.addEventListener("close", () => {
    clearForceCloseTimer();
    if (!deliberateClose && !serverClosed && !errorReported) {
      reportError("network_error");
    }
    handlers.onClose();
  });

  return {
    close() {
      deliberateClose = true;
      ready = false;
      if (socket.readyState === WebSocket.OPEN) {
        sendMessage(socket, { type: "close" });
        forceCloseAfterGracePeriod();
      } else if (socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    },
    dispose() {
      deliberateClose = true;
      ready = false;
      clearForceCloseTimer();
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
      }
    },
    resize(cols, rows) {
      if (ready && socket.readyState === WebSocket.OPEN) {
        sendMessage(socket, { cols, rows, type: "resize" });
      }
    },
    write(data) {
      if (ready && socket.readyState === WebSocket.OPEN && data) {
        sendMessage(socket, { data, type: "input" });
      }
    },
  };
}

export function parseTerminalServerMessage(
  source: string,
): TerminalServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }

  if (
    value.type === "ready" &&
    typeof value.expiresAt === "string" &&
    !Number.isNaN(Date.parse(value.expiresAt))
  ) {
    return { expiresAt: value.expiresAt, type: "ready" };
  }
  if (
    value.type === "closed" &&
    Number.isSafeInteger(value.exitCode)
  ) {
    return {
      exitCode: value.exitCode as number,
      type: "closed",
    };
  }
  if (
    value.type === "error" &&
    isTerminalServerErrorCode(value.code)
  ) {
    return { code: value.code, type: "error" };
  }

  return null;
}

function sendMessage(
  socket: WebSocket,
  message: TerminalClientMessage,
) {
  socket.send(JSON.stringify(message));
}

function projectTerminalUrl(projectId: string) {
  const url = new URL(
    `/api/projects/${encodeURIComponent(projectId)}/terminal`,
    window.location.href,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTerminalServerErrorCode(
  value: unknown,
): value is TerminalServerErrorCode {
  return (
    value === "invalid_message" ||
    value === "project_busy" ||
    value === "provider_error" ||
    value === "sandbox_unavailable"
  );
}

function messageForTerminalError(
  code: TerminalServerErrorCode | "network_error",
) {
  switch (code) {
    case "invalid_message":
      return "终端协议请求无效，请重新连接。";
    case "project_busy":
      return "该项目已有正在执行的 Agent Run 或终端会话。";
    case "sandbox_unavailable":
      return "当前沙箱运行环境不支持终端。";
    case "provider_error":
      return "远程终端启动失败，请稍后重试。";
    case "network_error":
      return "终端连接已中断，请检查网络后重试。";
  }
}
