import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  FileCode2,
  FileQuestion,
  Folder,
  RefreshCw,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type { ProjectFileEntryResponse } from "../../shared/api";
import { BrowserApiError, browserApi } from "../api";
import {
  projectFileQueryKey,
  projectFilesQueryKey,
} from "../query-keys";
import { ErrorState, LoadingState } from "./ui-states";

export function ProjectFiles({
  hasActiveRun,
  projectId,
  sandboxAvailable,
}: {
  hasActiveRun: boolean;
  projectId: string;
  sandboxAvailable: boolean;
}) {
  const [directoryPath, setDirectoryPath] = useState("");
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  useEffect(() => {
    setDirectoryPath("");
    setSelectedFilePath(null);
  }, [projectId]);

  const directory = useQuery({
    enabled: sandboxAvailable && !hasActiveRun && selectedFilePath === null,
    queryFn: () => browserApi.listProjectFiles(projectId, directoryPath),
    queryKey: projectFilesQueryKey(projectId, directoryPath),
    retry: false,
  });
  const file = useQuery({
    enabled: sandboxAvailable && !hasActiveRun && selectedFilePath !== null,
    queryFn: () => browserApi.readProjectFile(projectId, selectedFilePath ?? ""),
    queryKey: projectFileQueryKey(projectId, selectedFilePath ?? ""),
    retry: false,
  });

  if (hasActiveRun) {
    return (
      <section className="project-files-view">
        <FilesNotice
          detail="Files become available again when the current project activity finishes."
          title="Sandbox is busy"
        />
      </section>
    );
  }

  if (!sandboxAvailable) {
    return (
      <section className="project-files-view">
        <FilesNotice
          detail="项目沙箱未启动或已停止。运行一次 Agent 后即可查看文件。"
          title="Sandbox not started"
        />
      </section>
    );
  }

  if (selectedFilePath !== null) {
    return (
      <section className="project-files-view">
        <FileToolbar
          onBack={() => setSelectedFilePath(null)}
          onRefresh={() => void file.refetch()}
          path={selectedFilePath}
        />
        {file.isPending ? <LoadingState label="Loading file" /> : null}
        {isUnavailableError(file.error) ? (
          <FilesNotice
            detail={file.error.message}
            title="File unavailable"
          />
        ) : file.error ? (
          <ErrorState
            compact
            error={file.error}
            onRetry={() => void file.refetch()}
          />
        ) : null}
        {!file.error && file.data ? (
          <pre className="project-file-content" tabIndex={0}>
            <code>{file.data.content}</code>
          </pre>
        ) : null}
      </section>
    );
  }

  return (
    <section className="project-files-view">
      <DirectoryToolbar
        onNavigate={setDirectoryPath}
        onRefresh={() => void directory.refetch()}
        path={directoryPath}
      />
      {directory.isPending ? <LoadingState label="Loading files" /> : null}
      {isUnavailableError(directory.error) ? (
        <FilesNotice
          detail={directory.error.message}
          title="Sandbox not started"
        />
      ) : directory.error ? (
        <ErrorState
          compact
          error={directory.error}
          onRetry={() => void directory.refetch()}
        />
      ) : null}
      {!directory.error && directory.data ? (
        <>
          {directory.data.entries.length > 0 ? (
            <div className="project-file-list">
              {directory.data.entries.map((entry) => (
                <FileRow
                  entry={entry}
                  key={entry.path}
                  onOpen={() => {
                    if (entry.kind === "directory") {
                      setDirectoryPath(entry.path);
                    } else if (entry.kind === "file") {
                      setSelectedFilePath(entry.path);
                    }
                  }}
                />
              ))}
            </div>
          ) : (
            <FilesNotice
              detail="This directory does not contain any visible files."
              title="Empty directory"
            />
          )}
          {directory.data.truncated ? (
            <p className="project-files-limit">
              Showing the first 500 entries.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function DirectoryToolbar({
  onNavigate,
  onRefresh,
  path,
}: {
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  path: string;
}) {
  const segments = path ? path.split("/") : [];
  return (
    <div className="project-files-toolbar">
      <nav aria-label="File path" className="project-file-breadcrumbs">
        <button onClick={() => onNavigate("")} type="button">
          workspace
        </button>
        {segments.map((segment, index) => (
          <span key={`${segment}-${index}`}>
            <ChevronRight aria-hidden="true" size={12} />
            <button
              onClick={() => onNavigate(segments.slice(0, index + 1).join("/"))}
              type="button"
            >
              {segment}
            </button>
          </span>
        ))}
      </nav>
      <IconButton label="Refresh files" onClick={onRefresh}>
        <RefreshCw aria-hidden="true" size={14} />
      </IconButton>
    </div>
  );
}

function FileToolbar({
  onBack,
  onRefresh,
  path,
}: {
  onBack: () => void;
  onRefresh: () => void;
  path: string;
}) {
  return (
    <div className="project-files-toolbar">
      <button className="project-file-back" onClick={onBack} type="button">
        <ChevronLeft aria-hidden="true" size={14} />
        <span>{path.split("/").at(-1)}</span>
      </button>
      <IconButton label="Refresh file" onClick={onRefresh}>
        <RefreshCw aria-hidden="true" size={14} />
      </IconButton>
    </div>
  );
}

function FileRow({
  entry,
  onOpen,
}: {
  entry: ProjectFileEntryResponse;
  onOpen: () => void;
}) {
  const disabled = entry.kind === "symlink";
  return (
    <button
      className="project-file-row"
      disabled={disabled}
      onClick={onOpen}
      title={disabled ? "Symbolic links are not available" : entry.name}
      type="button"
    >
      {entry.kind === "directory" ? (
        <Folder aria-hidden="true" size={15} />
      ) : entry.kind === "file" ? (
        <FileCode2 aria-hidden="true" size={15} />
      ) : (
        <FileQuestion aria-hidden="true" size={15} />
      )}
      <span>{entry.name}</span>
      <small>{entry.kind === "file" ? formatFileSize(entry.size) : ""}</small>
      {!disabled ? <ChevronRight aria-hidden="true" size={13} /> : null}
    </button>
  );
}

function IconButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="project-files-icon-action"
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

function FilesNotice({ detail, title }: { detail: string; title: string }) {
  return (
    <div className="project-files-notice">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function formatFileSize(bytes: number) {
  if (bytes < 1_024) {
    return `${bytes} B`;
  }
  if (bytes < 1_024 * 1_024) {
    return `${(bytes / 1_024).toFixed(bytes < 10 * 1_024 ? 1 : 0)} KB`;
  }
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function isUnavailableError(error: Error | null): error is BrowserApiError {
  return (
    error instanceof BrowserApiError &&
    (error.code === "project_busy" || error.code === "sandbox_unavailable")
  );
}
