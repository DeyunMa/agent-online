import { FileNotFoundError, FileType, Sandbox, SandboxNotFoundError } from "e2b";

import type {
  EnsureLeaseInput,
  PreviewStopReason,
  ProcessTerminationReason,
  RuntimeHandle,
  SandboxChangeEntry,
  SandboxChangesRuntime,
  SandboxCommand,
  SandboxFileEntry,
  SandboxPreviewRequest,
  SandboxPreviewRuntime,
  SandboxPreviewStartInput,
  SandboxRuntime,
  SandboxStopReason,
  SandboxTerminalRuntime,
  SandboxTerminalSize,
  TerminalCloseReason,
} from "./contract";
import { SandboxPathNotFoundError, SandboxUnavailableError } from "./contract";
import { listE2BChanges, readE2BChangeDiff } from "./e2b-changes";
import {
  assertE2BPreviewStartInput,
  createE2BVitePreviewCommand,
  e2bPreviewConfig,
  e2bPreviewConfigPath,
  fetchE2BPreview,
  inspectE2BPreview,
  requireE2BTrafficAccessToken,
  toE2BPreviewStartError,
  waitForE2BPreviewReady,
  writeE2BPreviewConfigWithCommand,
} from "./e2b-preview";
import { startE2BProcessSession, startE2BTerminalSession } from "./e2b-sessions";
import { toShellCommand } from "./e2b-shell";
import type { E2BCommandHandle, E2BSandbox, E2BSandboxClient } from "./e2b-types";

export type { E2BSandboxClient } from "./e2b-types";

export type E2BSandboxRuntimeOptions = {
  apiKey: string;
  changesTimeoutMs?: number;
  client?: E2BSandboxClient;
  processTimeoutMs?: number;
  sandboxTimeoutMs?: number;
  templateId: string;
  terminalOutputLimitBytes?: number;
  terminalPendingOutputBytes?: number;
  terminalTimeoutMs?: number;
};

const defaultSandboxTimeoutMs = 30 * 60 * 1_000;
const defaultProcessTimeoutMs = 30 * 60 * 1_000;
const defaultTerminalTimeoutMs = 30 * 60 * 1_000;
const defaultChangesTimeoutMs = 15_000;
export const defaultTerminalOutputLimitBytes = 8 * 1_024 * 1_024;
export const defaultTerminalPendingOutputBytes = 256 * 1_024;

const defaultClient: E2BSandboxClient = {
  connect: (sandboxId, options) => Sandbox.connect(sandboxId, options),
  create: (templateId, options) => Sandbox.create(templateId, options),
};

export class E2BSandboxRuntime
  implements SandboxChangesRuntime, SandboxPreviewRuntime, SandboxRuntime, SandboxTerminalRuntime
{
  readonly filesystemScope = "lease" as const;
  readonly kind = "e2b" as const;

  private readonly client: E2BSandboxClient;
  private readonly changesTimeoutMs: number;
  private readonly processTimeoutMs: number;
  private readonly sandboxTimeoutMs: number;
  private readonly terminalOutputLimitBytes: number;
  private readonly terminalPendingOutputBytes: number;
  private readonly terminalTimeoutMs: number;
  private readonly sandboxes = new Map<string, E2BSandbox>();

  constructor(private readonly options: E2BSandboxRuntimeOptions) {
    if (!options.apiKey || !options.templateId) {
      throw new Error("E2BSandboxRuntime requires apiKey and templateId");
    }

    this.client = options.client ?? defaultClient;
    this.changesTimeoutMs = requirePositiveTimeout(
      options.changesTimeoutMs ?? defaultChangesTimeoutMs,
    );
    this.processTimeoutMs = requirePositiveTimeout(
      options.processTimeoutMs ?? defaultProcessTimeoutMs,
    );
    this.sandboxTimeoutMs = requirePositiveTimeout(
      options.sandboxTimeoutMs ?? defaultSandboxTimeoutMs,
    );
    this.terminalOutputLimitBytes = requirePositiveTimeout(
      options.terminalOutputLimitBytes ?? defaultTerminalOutputLimitBytes,
    );
    this.terminalPendingOutputBytes = requirePositiveTimeout(
      options.terminalPendingOutputBytes ?? defaultTerminalPendingOutputBytes,
    );
    this.terminalTimeoutMs = requirePositiveTimeout(
      options.terminalTimeoutMs ?? defaultTerminalTimeoutMs,
    );
  }

  async ensureLease(input: EnsureLeaseInput): Promise<RuntimeHandle> {
    if (input.providerRef) {
      try {
        const existing = await this.client.connect(input.providerRef, {
          apiKey: this.options.apiKey,
        });
        await existing.setTimeout(this.sandboxTimeoutMs);
        this.sandboxes.set(existing.sandboxId, existing);
        return { id: existing.sandboxId, kind: this.kind, sandboxLeaseId: input.sandboxLeaseId };
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) {
          throw error;
        }
      }
    }

    const sandbox = await this.client.create(this.options.templateId, {
      apiKey: this.options.apiKey,
      metadata: {
        app: "agent-online",
        projectId: input.projectId,
        sandboxLeaseId: input.sandboxLeaseId,
      },
      network: {
        allowPublicTraffic: false,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: E2B expands this port placeholder.
        maskRequestHost: "localhost:${PORT}",
      },
      timeoutMs: this.sandboxTimeoutMs,
    });
    this.sandboxes.set(sandbox.sandboxId, sandbox);
    return { id: sandbox.sandboxId, kind: this.kind, sandboxLeaseId: input.sandboxLeaseId };
  }

  async startProcess(handle: RuntimeHandle, command: SandboxCommand) {
    return startE2BProcessSession(
      this.requireSandbox(handle),
      handle,
      command,
      this.processTimeoutMs,
    );
  }

  async startTerminal(handle: RuntimeHandle, input: SandboxTerminalSize & { cwd: string }) {
    return startE2BTerminalSession(await this.attachSandbox(handle), handle, input, {
      outputLimitBytes: this.terminalOutputLimitBytes,
      pendingOutputBytes: this.terminalPendingOutputBytes,
      timeoutMs: this.terminalTimeoutMs,
    });
  }

  async listDirectory(handle: RuntimeHandle, path: string): Promise<SandboxFileEntry[]> {
    try {
      const sandbox = await this.attachSandbox(handle);
      const entries = await sandbox.files.list(path);
      return entries.map((entry) => ({
        kind: toSandboxFileEntryKind(entry.type),
        modifiedAt: entry.modifiedTime?.toISOString() ?? null,
        name: entry.name,
        size: entry.size,
      }));
    } catch (error) {
      throw mapFilesystemError(error, path);
    }
  }

  async listChanges(handle: RuntimeHandle) {
    try {
      return await listE2BChanges(await this.attachSandbox(handle), this.changesTimeoutMs);
    } catch (error) {
      if (error instanceof SandboxNotFoundError) {
        throw new SandboxUnavailableError();
      }
      throw error;
    }
  }

  async readChangeDiff(handle: RuntimeHandle, change: SandboxChangeEntry) {
    try {
      return await readE2BChangeDiff(
        await this.attachSandbox(handle),
        change,
        this.changesTimeoutMs,
      );
    } catch (error) {
      if (error instanceof SandboxNotFoundError) {
        throw new SandboxUnavailableError();
      }
      throw error;
    }
  }

  async readFile(handle: RuntimeHandle, path: string) {
    try {
      const sandbox = await this.attachSandbox(handle);
      return await sandbox.files.read(path, { format: "bytes" });
    } catch (error) {
      throw mapFilesystemError(error, path);
    }
  }

  async stop(handle: RuntimeHandle, _reason: SandboxStopReason) {
    assertRuntimeHandle(handle, this.kind);

    let sandbox = this.sandboxes.get(handle.id);
    if (!sandbox) {
      try {
        sandbox = await this.client.connect(handle.id, { apiKey: this.options.apiKey });
      } catch (error) {
        if (error instanceof SandboxNotFoundError) {
          return;
        }
        throw error;
      }
    }

    await sandbox.kill();
    this.sandboxes.delete(handle.id);
  }

  async terminateProcess(
    handle: RuntimeHandle,
    providerProcessRef: string,
    _reason: ProcessTerminationReason,
  ) {
    const sandbox = await this.attachSandbox(handle);
    const processId = parseProviderProcessRef(providerProcessRef, "process");
    const killed = await sandbox.commands.kill(processId);
    if (!killed) {
      throw new Error(`E2B process was not found: ${providerProcessRef}`);
    }
  }

  async terminateTerminal(
    handle: RuntimeHandle,
    providerProcessRef: string,
    _reason: TerminalCloseReason,
  ) {
    const sandbox = await this.attachSandbox(handle);
    const processId = parseProviderProcessRef(providerProcessRef, "terminal");
    await sandbox.pty.kill(processId);
  }

  async startPreview(handle: RuntimeHandle, input: SandboxPreviewStartInput) {
    assertE2BPreviewStartInput(input);
    const preset = createE2BVitePreviewCommand(input.contentBasePath);
    let process: E2BCommandHandle | undefined;
    let sandbox: E2BSandbox | undefined;
    let stage:
      | "attach"
      | "command_start"
      | "disconnect"
      | "reconnect_after_write"
      | "traffic_token"
      | "wait_ready"
      | "write_config"
      | "write_config_command"
      | "write_config_retry" = "attach";
    try {
      sandbox = await this.attachSandbox(handle);
      stage = "traffic_token";
      if (!sandbox.trafficAccessToken) {
        sandbox = await this.client.connect(handle.id, { apiKey: this.options.apiKey });
        this.sandboxes.set(sandbox.sandboxId, sandbox);
      }
      requireE2BTrafficAccessToken(sandbox);

      stage = "write_config";
      try {
        await sandbox.files.write(e2bPreviewConfigPath, e2bPreviewConfig);
      } catch {
        stage = "reconnect_after_write";
        sandbox = await this.client.connect(handle.id, { apiKey: this.options.apiKey });
        this.sandboxes.set(sandbox.sandboxId, sandbox);
        requireE2BTrafficAccessToken(sandbox);
        stage = "write_config_retry";
        try {
          await sandbox.files.write(e2bPreviewConfigPath, e2bPreviewConfig);
        } catch {
          stage = "write_config_command";
          await writeE2BPreviewConfigWithCommand(sandbox);
        }
      }

      stage = "command_start";
      const startedProcess = await sandbox.commands.run(toShellCommand(preset), {
        background: true,
        cwd: preset.cwd,
        envs: { ...preset.env },
        timeoutMs: input.processTimeoutMs,
      });
      process = startedProcess;
      stage = "wait_ready";
      await waitForE2BPreviewReady(
        sandbox,
        startedProcess.pid,
        input.port,
        input.contentBasePath,
        input.startupTimeoutMs,
      );
      stage = "disconnect";
      await startedProcess.disconnect();
      return { providerProcessRef: String(startedProcess.pid) };
    } catch (error) {
      if (sandbox && process) {
        await sandbox.commands.kill(process.pid).catch(() => false);
      }
      throw toE2BPreviewStartError(stage, error);
    }
  }

  async inspectPreview(handle: RuntimeHandle) {
    return inspectE2BPreview(await this.attachSandbox(handle));
  }

  async isPreviewRunning(handle: RuntimeHandle, providerProcessRef: string, _port: number) {
    try {
      const sandbox = await this.attachSandbox(handle);
      const processId = parseProviderProcessRef(providerProcessRef, "preview");
      const processes = await sandbox.commands.list();
      return processes.some((process) => process.pid === processId);
    } catch (error) {
      if (error instanceof SandboxNotFoundError) {
        return false;
      }
      throw error;
    }
  }

  async terminatePreview(
    handle: RuntimeHandle,
    providerProcessRef: string,
    _reason: PreviewStopReason,
  ) {
    try {
      const sandbox = await this.attachSandbox(handle);
      const processId = parseProviderProcessRef(providerProcessRef, "preview");
      await sandbox.commands.kill(processId);
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) {
        throw error;
      }
    }
  }

  async fetchPreview(handle: RuntimeHandle, port: number, request: SandboxPreviewRequest) {
    try {
      return await fetchE2BPreview(await this.attachSandbox(handle), port, request);
    } catch (error) {
      if (error instanceof SandboxNotFoundError) {
        throw new SandboxUnavailableError();
      }
      throw error;
    }
  }

  async writeFile(handle: RuntimeHandle, path: string, content: string) {
    await this.requireSandbox(handle).files.write(path, content);
  }

  private requireSandbox(handle: RuntimeHandle) {
    assertRuntimeHandle(handle, this.kind);
    const sandbox = this.sandboxes.get(handle.id);
    if (!sandbox) {
      throw new Error(`E2B runtime handle is not attached: ${handle.id}`);
    }
    return sandbox;
  }

  private async attachSandbox(handle: RuntimeHandle) {
    assertRuntimeHandle(handle, this.kind);
    const cached = this.sandboxes.get(handle.id);
    if (cached) {
      return cached;
    }

    const sandbox = await this.client.connect(handle.id, { apiKey: this.options.apiKey });
    this.sandboxes.set(sandbox.sandboxId, sandbox);
    return sandbox;
  }
}

function toSandboxFileEntryKind(type: FileType | undefined): SandboxFileEntry["kind"] {
  if (type === FileType.DIR) {
    return "directory";
  }
  if (type === FileType.FILE) {
    return "file";
  }
  return "symlink";
}

function mapFilesystemError(error: unknown, path: string): Error {
  if (error instanceof SandboxNotFoundError) {
    return new SandboxUnavailableError();
  }
  if (error instanceof FileNotFoundError) {
    return new SandboxPathNotFoundError(path);
  }
  return error instanceof Error ? error : new Error("Sandbox filesystem request failed");
}

function assertRuntimeHandle(handle: RuntimeHandle, kind: "e2b") {
  if (handle.kind !== kind || !handle.id || !handle.sandboxLeaseId) {
    throw new Error("E2BSandboxRuntime received an invalid runtime handle");
  }
}

function parseProviderProcessRef(value: string, kind: "preview" | "process" | "terminal") {
  const processId = Number(value);
  if (!Number.isSafeInteger(processId) || processId < 1) {
    throw new Error(`E2B ${kind} reference is invalid`);
  }
  return processId;
}

function requirePositiveTimeout(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("E2BSandboxRuntime timeouts must be positive safe integers");
  }
  return value;
}
