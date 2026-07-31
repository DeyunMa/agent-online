import type {
  CommandHandle,
  CommandStartOpts,
  EntryInfo,
  SandboxConnectOpts,
  SandboxOpts,
} from "e2b";

import type { SandboxTerminalSize } from "./contract";

export type E2BCommandHandle = Pick<
  CommandHandle,
  "disconnect" | "kill" | "pid" | "sendStdin" | "wait"
>;

export type E2BPty = {
  create(options: {
    cols: number;
    cwd: string;
    onData(data: Uint8Array): void | Promise<void>;
    rows: number;
    timeoutMs: number;
  }): Promise<E2BCommandHandle>;
  kill(pid: number): Promise<boolean>;
  resize(pid: number, size: SandboxTerminalSize): Promise<void>;
  sendInput(pid: number, data: Uint8Array): Promise<void>;
};

export type E2BSandbox = {
  commands: {
    kill(pid: number): Promise<boolean>;
    list(): Promise<Array<{ pid: number }>>;
    run(
      command: string,
      options: CommandStartOpts & { background: true },
    ): Promise<E2BCommandHandle>;
  };
  files: {
    list(path: string): Promise<EntryInfo[]>;
    read(path: string, options: { format: "bytes" }): Promise<Uint8Array>;
    write(path: string, content: string | ArrayBuffer): Promise<unknown>;
  };
  getHost(port: number): string;
  kill(): Promise<boolean>;
  pty: E2BPty;
  sandboxId: string;
  setTimeout(timeoutMs: number): Promise<void>;
  trafficAccessToken?: string;
};

export type E2BSandboxClient = {
  connect(sandboxId: string, options: SandboxConnectOpts): Promise<E2BSandbox>;
  create(templateId: string, options: SandboxOpts): Promise<E2BSandbox>;
};
