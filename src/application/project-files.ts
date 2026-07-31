import type {
  AgentRunRepository,
  SandboxLeaseRecord,
  SandboxLeaseRepository,
  TerminalSessionRepository,
} from "./ports";
import type {
  RuntimeHandle,
  RuntimeKind,
  SandboxFileEntry,
  SandboxFilesystemRuntime,
} from "../runtime/contract";
import { SandboxPathNotFoundError, SandboxUnavailableError } from "../runtime/contract";

const maxDirectoryEntries = 500;
const maxFileBytes = 256 * 1_024;
export const maxProjectFileUploadBytes = 4 * 1_024 * 1_024;
const maxPathLength = 512;
const maxPathDepth = 32;

export type ProjectFileEntry = {
  kind: SandboxFileEntry["kind"];
  modifiedAt: string | null;
  name: string;
  path: string;
  size: number;
};

export type ProjectDirectory = {
  entries: ProjectFileEntry[];
  path: string;
  truncated: boolean;
};

export type ProjectTextFile = {
  content: string;
  modifiedAt: string | null;
  name: string;
  path: string;
  size: number;
};

export type ProjectFilesFailure =
  | { kind: "file_too_large" }
  | { kind: "path_not_found" }
  | { kind: "path_conflict" }
  | { kind: "project_busy" }
  | { kind: "provider_error" }
  | { kind: "sandbox_unavailable" }
  | { kind: "unsupported_file" }
  | { kind: "unsupported_path" };

export type ListProjectDirectoryResult =
  | { directory: ProjectDirectory; kind: "ok" }
  | ProjectFilesFailure;

export type ReadProjectFileResult = { file: ProjectTextFile; kind: "ok" } | ProjectFilesFailure;

export type UploadProjectFileResult =
  | {
      file: {
        name: string;
        path: string;
        size: number;
      };
      kind: "ok";
    }
  | ProjectFilesFailure;

export type ProjectFilesServiceOptions = {
  agentRuns: Pick<AgentRunRepository, "findActiveByProjectId">;
  getSandboxRuntime: (id: RuntimeKind) => SandboxFilesystemRuntime;
  now(): Date;
  sandboxLeases: Pick<SandboxLeaseRepository, "findByProjectId">;
  terminalSessions: Pick<TerminalSessionRepository, "findByProjectId">;
  workingDirectory: string;
};

export class ProjectFilesService {
  constructor(private readonly options: ProjectFilesServiceOptions) {}

  async list(projectId: string, rawPath: string | undefined): Promise<ListProjectDirectoryResult> {
    const path = parseProjectPath(rawPath, true);
    if (!path) {
      return { kind: "unsupported_path" };
    }

    const access = await this.getAccess(projectId);
    if (access.kind !== "ok") {
      return access;
    }

    try {
      if (path.segments.length > 0) {
        const target = await inspectPath(
          access.runtime,
          access.handle,
          this.options.workingDirectory,
          path.segments,
        );
        if (target.kind !== "directory") {
          return { kind: "unsupported_path" };
        }
      }

      const entries = (
        await access.runtime.listDirectory(
          access.handle,
          toAbsolutePath(this.options.workingDirectory, path.segments),
        )
      )
        .filter(isSafeEntry)
        .map((entry) => ({
          ...entry,
          path: [...path.segments, entry.name].join("/"),
        }))
        .sort(compareEntries);

      return {
        directory: {
          entries: entries.slice(0, maxDirectoryEntries),
          path: path.value,
          truncated: entries.length > maxDirectoryEntries,
        },
        kind: "ok",
      };
    } catch (error) {
      return toFailure(error);
    }
  }

  async read(projectId: string, rawPath: string | undefined): Promise<ReadProjectFileResult> {
    const path = parseProjectPath(rawPath, false);
    if (!path) {
      return { kind: "unsupported_path" };
    }

    const access = await this.getAccess(projectId);
    if (access.kind !== "ok") {
      return access;
    }

    try {
      const entry = await inspectPath(
        access.runtime,
        access.handle,
        this.options.workingDirectory,
        path.segments,
      );
      if (entry.kind !== "file") {
        return { kind: "unsupported_file" };
      }
      if (entry.size > maxFileBytes) {
        return { kind: "file_too_large" };
      }

      const bytes = await access.runtime.readFile(
        access.handle,
        toAbsolutePath(this.options.workingDirectory, path.segments),
      );
      if (bytes.byteLength > maxFileBytes) {
        return { kind: "file_too_large" };
      }

      const content = decodeText(bytes);
      if (content === null) {
        return { kind: "unsupported_file" };
      }

      return {
        file: {
          content,
          modifiedAt: entry.modifiedAt,
          name: entry.name,
          path: path.value,
          size: bytes.byteLength,
        },
        kind: "ok",
      };
    } catch (error) {
      return toFailure(error);
    }
  }

  async upload(
    projectId: string,
    input: { bytes: Uint8Array; name: string },
  ): Promise<UploadProjectFileResult> {
    const path = parseProjectPath(input.name, false);
    if (path?.segments.length !== 1) {
      return { kind: "unsupported_path" };
    }
    if (input.bytes.byteLength > maxProjectFileUploadBytes) {
      return { kind: "file_too_large" };
    }

    const access = await this.getAccess(projectId);
    if (access.kind !== "ok") {
      return access;
    }

    try {
      const rootEntries = await access.runtime.listDirectory(
        access.handle,
        this.options.workingDirectory,
      );
      if (rootEntries.some((entry) => entry.name === path.value)) {
        return { kind: "path_conflict" };
      }

      await access.runtime.writeFile(
        access.handle,
        toAbsolutePath(this.options.workingDirectory, path.segments),
        input.bytes,
      );
      return {
        file: {
          name: path.value,
          path: path.value,
          size: input.bytes.byteLength,
        },
        kind: "ok",
      };
    } catch (error) {
      return toFailure(error);
    }
  }

  private async getAccess(
    projectId: string,
  ): Promise<
    | { handle: RuntimeHandle; kind: "ok"; runtime: SandboxFilesystemRuntime }
    | Extract<
        ProjectFilesFailure,
        { kind: "project_busy" | "provider_error" | "sandbox_unavailable" }
      >
  > {
    if (await this.options.agentRuns.findActiveByProjectId(projectId)) {
      return { kind: "project_busy" };
    }
    if (await this.options.terminalSessions.findByProjectId(projectId)) {
      return { kind: "project_busy" };
    }

    const lease = await this.options.sandboxLeases.findByProjectId(projectId);
    if (!lease?.providerRef) {
      return { kind: "sandbox_unavailable" };
    }
    if (lease.status === "busy" || lease.status === "starting") {
      return { kind: "project_busy" };
    }
    if (lease.status !== "idle" && lease.status !== "ready") {
      return { kind: "sandbox_unavailable" };
    }

    try {
      const runtime = this.options.getSandboxRuntime(lease.runtimeId);
      if (runtime.filesystemScope !== "lease") {
        return { kind: "sandbox_unavailable" };
      }
      return {
        handle: toRuntimeHandle(lease),
        kind: "ok",
        runtime,
      };
    } catch {
      return { kind: "provider_error" };
    }
  }
}

async function inspectPath(
  runtime: SandboxFilesystemRuntime,
  handle: RuntimeHandle,
  workingDirectory: string,
  segments: readonly string[],
) {
  let entry: SandboxFileEntry | null = null;

  for (let index = 0; index < segments.length; index += 1) {
    const parent = segments.slice(0, index);
    const entries = await runtime.listDirectory(handle, toAbsolutePath(workingDirectory, parent));
    entry = entries.find((candidate) => candidate.name === segments[index]) ?? null;

    if (!entry) {
      throw new SandboxPathNotFoundError(segments.join("/"));
    }
    if (entry.kind === "symlink") {
      throw new UnsupportedProjectPathError();
    }
    if (index < segments.length - 1 && entry.kind !== "directory") {
      throw new SandboxPathNotFoundError(segments.join("/"));
    }
  }

  if (!entry) {
    throw new SandboxPathNotFoundError(segments.join("/"));
  }
  return entry;
}

function parseProjectPath(rawPath: string | undefined, allowRoot: boolean) {
  const value = rawPath ?? "";
  if (value === "") {
    return allowRoot ? { segments: [] as string[], value } : null;
  }
  if (
    value.length > maxPathLength ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    hasAsciiControlCharacter(value)
  ) {
    return null;
  }

  const segments = value.split("/");
  if (
    segments.length > maxPathDepth ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment.length > 255 ||
        segment === "." ||
        segment === ".." ||
        segment === ".git",
    )
  ) {
    return null;
  }

  return { segments, value };
}

function toAbsolutePath(workingDirectory: string, segments: readonly string[]) {
  const root = workingDirectory.replace(/\/+$/u, "");
  return segments.length === 0 ? root : `${root}/${segments.join("/")}`;
}

function toRuntimeHandle(lease: SandboxLeaseRecord): RuntimeHandle {
  if (!lease.providerRef) {
    throw new SandboxUnavailableError();
  }
  return {
    id: lease.providerRef,
    kind: lease.runtimeId,
    sandboxLeaseId: lease.id,
  };
}

function isSafeEntry(entry: SandboxFileEntry) {
  return (
    Number.isSafeInteger(entry.size) &&
    entry.size >= 0 &&
    entry.name.length > 0 &&
    entry.name.length <= 255 &&
    entry.name !== "." &&
    entry.name !== ".." &&
    entry.name !== ".git" &&
    !entry.name.includes("/") &&
    !entry.name.includes("\\") &&
    !hasAsciiControlCharacter(entry.name)
  );
}

function hasAsciiControlCharacter(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function compareEntries(left: ProjectFileEntry, right: ProjectFileEntry) {
  const leftRank = left.kind === "directory" ? 0 : left.kind === "file" ? 1 : 2;
  const rightRank = right.kind === "directory" ? 0 : right.kind === "file" ? 1 : 2;
  return leftRank - rightRank || left.name.localeCompare(right.name);
}

function decodeText(bytes: Uint8Array) {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }

  let controlCharacters = 0;
  for (const character of content) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0) {
      return null;
    }
    if (code < 9 || (code > 13 && code < 32)) {
      controlCharacters += 1;
    }
  }

  return controlCharacters > Math.max(4, content.length * 0.01) ? null : content;
}

function toFailure(error: unknown): ProjectFilesFailure {
  if (error instanceof SandboxPathNotFoundError) {
    return { kind: "path_not_found" };
  }
  if (error instanceof SandboxUnavailableError) {
    return { kind: "sandbox_unavailable" };
  }
  if (error instanceof UnsupportedProjectPathError) {
    return { kind: "unsupported_path" };
  }
  return { kind: "provider_error" };
}

class UnsupportedProjectPathError extends Error {}
