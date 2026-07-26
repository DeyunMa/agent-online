export type TerminalClientMessage =
  | { cols: number; rows: number; type: "attach" }
  | { data: string; type: "input" }
  | { cols: number; rows: number; type: "resize" }
  | { type: "close" };

export type TerminalServerErrorCode =
  | "invalid_message"
  | "project_busy"
  | "provider_error"
  | "sandbox_unavailable";

export type TerminalServerMessage =
  | { expiresAt: string; type: "ready" }
  | { exitCode: number; type: "closed" }
  | { code: TerminalServerErrorCode; type: "error" };
