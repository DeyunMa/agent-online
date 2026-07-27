import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, FileDiff, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import type {
  ProjectChangeDiffSectionResponse,
  ProjectChangeEntryResponse,
} from "../../shared/api";
import { BrowserApiError, browserApi } from "../api";
import { projectChangeQueryKey, projectChangesQueryKey } from "../query-keys";
import { ErrorState, LoadingState } from "./ui-states";

export function ProjectChanges({
  projectBusy,
  projectId,
  sandboxAvailable,
}: {
  projectBusy: boolean;
  projectId: string;
  sandboxAvailable: boolean;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Project identity intentionally resets local selection.
  useEffect(() => {
    setSelectedPath(null);
  }, [projectId]);

  const changes = useQuery({
    enabled: sandboxAvailable && !projectBusy,
    gcTime: 0,
    queryFn: () => browserApi.listProjectChanges(projectId),
    queryKey: projectChangesQueryKey(projectId),
    retry: false,
  });
  const detail = useQuery({
    enabled: sandboxAvailable && !projectBusy && selectedPath !== null,
    gcTime: 0,
    queryFn: () => browserApi.readProjectChange(projectId, selectedPath ?? ""),
    queryKey: projectChangeQueryKey(projectId, selectedPath ?? ""),
    retry: false,
  });

  if (projectBusy) {
    return (
      <ChangesNotice
        detail="Changes become available when the current Run or Terminal closes."
        title="Sandbox is busy"
      />
    );
  }

  if (!sandboxAvailable) {
    return (
      <ChangesNotice
        detail="Run the Agent once to start this Project sandbox."
        title="Sandbox not started"
      />
    );
  }

  if (selectedPath !== null) {
    return (
      <section className="project-changes-view">
        <ChangesToolbar
          label={selectedPath}
          onBack={() => setSelectedPath(null)}
          onRefresh={() => void detail.refetch()}
        />
        {detail.isPending ? <LoadingState label="Loading change" /> : null}
        {isUnavailableError(detail.error) ? (
          <ChangesNotice detail={detail.error.message} title="Change unavailable" />
        ) : detail.error ? (
          <ErrorState compact error={detail.error} onRetry={() => void detail.refetch()} />
        ) : null}
        {!detail.error && detail.data ? (
          <ChangeDiff staged={detail.data.staged} unstaged={detail.data.unstaged} />
        ) : null}
      </section>
    );
  }

  return (
    <section className="project-changes-view">
      <ChangesToolbar label="Current changes" onRefresh={() => void changes.refetch()} />
      {changes.isPending ? <LoadingState label="Loading changes" /> : null}
      {isUnavailableError(changes.error) ? (
        <ChangesNotice detail={changes.error.message} title="Changes unavailable" />
      ) : changes.error ? (
        <ErrorState compact error={changes.error} onRetry={() => void changes.refetch()} />
      ) : null}
      {!changes.error && changes.data ? (
        !changes.data.repository ? (
          <ChangesNotice
            detail="Changes are available after the Project initializes a Git repository."
            title="Not a Git repository"
          />
        ) : changes.data.entries.length === 0 &&
          !changes.data.truncated &&
          !changes.data.unsupportedEntries ? (
          <ChangesNotice
            detail="The Git index and working tree have no visible changes."
            title="Working tree clean"
          />
        ) : (
          <>
            {changes.data.entries.length > 0 ? (
              <div className="project-change-list">
                {changes.data.entries.map((change) => (
                  <ChangeRow
                    change={change}
                    key={`${change.path}:${change.previousPath ?? ""}`}
                    onOpen={() => setSelectedPath(change.path)}
                  />
                ))}
              </div>
            ) : null}
            {changes.data.truncated ? (
              <p className="project-changes-limit">
                Showing a partial change list because the 500-entry or 128 KiB limit was reached.
              </p>
            ) : null}
            {changes.data.unsupportedEntries ? (
              <ChangesNotice
                detail="Some Git paths cannot be displayed safely and are omitted from this view."
                title="Some changes are hidden"
              />
            ) : null}
          </>
        )
      ) : null}
    </section>
  );
}

function ChangesToolbar({
  label,
  onBack,
  onRefresh,
}: {
  label: string;
  onBack?: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="project-changes-toolbar">
      {onBack ? (
        <button className="project-change-back" onClick={onBack} title={label} type="button">
          <ChevronLeft aria-hidden="true" size={14} />
          <span>{label}</span>
        </button>
      ) : (
        <span className="project-changes-heading">{label}</span>
      )}
      <button
        aria-label="Refresh changes"
        className="project-changes-icon-action"
        onClick={onRefresh}
        title="Refresh changes"
        type="button"
      >
        <RefreshCw aria-hidden="true" size={14} />
      </button>
    </div>
  );
}

function ChangeRow({ change, onOpen }: { change: ProjectChangeEntryResponse; onOpen: () => void }) {
  return (
    <button className="project-change-row" onClick={onOpen} title={change.path} type="button">
      <span
        role="img"
        aria-label={changeSummaryLabel(change)}
        className={`project-change-kind change-kind-${primaryChangeKind(change)}`}
      >
        {changeKindSummaryCode(change)}
      </span>
      <span className="project-change-path">
        <strong>{change.path}</strong>
        {change.previousPath ? <small>from {change.previousPath}</small> : null}
      </span>
      <span className="project-change-scopes">
        {change.stagedKind ? <small>staged {changeKindCode(change.stagedKind)}</small> : null}
        {change.unstagedKind ? <small>unstaged {changeKindCode(change.unstagedKind)}</small> : null}
      </span>
      <ChevronRight aria-hidden="true" size={13} />
    </button>
  );
}

function ChangeDiff({
  staged,
  unstaged,
}: {
  staged: ProjectChangeDiffSectionResponse | null;
  unstaged: ProjectChangeDiffSectionResponse | null;
}) {
  return (
    <div className="project-change-diff">
      {staged ? <DiffSection label="Staged" section={staged} /> : null}
      {unstaged ? <DiffSection label="Unstaged" section={unstaged} /> : null}
      {!staged && !unstaged ? (
        <ChangesNotice
          detail="Git did not return a textual diff for this entry."
          title="No textual diff"
        />
      ) : null}
    </div>
  );
}

function DiffSection({
  label,
  section,
}: {
  label: string;
  section: ProjectChangeDiffSectionResponse;
}) {
  return (
    <section className="project-change-diff-section">
      <header>
        <span>{label}</span>
        {section.truncated ? <small>truncated</small> : null}
      </header>
      {section.content ? (
        <pre>
          <code>
            {section.content.split("\n").map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Immutable diff lines can repeat and carry no component state.
              <span className={diffLineClass(line)} key={`${index}:${line.slice(0, 24)}`}>
                {line || " "}
                {"\n"}
              </span>
            ))}
          </code>
        </pre>
      ) : (
        <p>No textual diff.</p>
      )}
    </section>
  );
}

function ChangesNotice({ detail, title }: { detail: string; title: string }) {
  return (
    <div className="project-changes-notice">
      <FileDiff aria-hidden="true" size={16} />
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}

function diffLineClass(line: string) {
  if (line.startsWith("@@")) {
    return "diff-line-hunk";
  }
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "diff-line-added";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "diff-line-deleted";
  }
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("---") ||
    line.startsWith("+++")
  ) {
    return "diff-line-meta";
  }
  return "diff-line-context";
}

function changeKindCode(kind: NonNullable<ProjectChangeEntryResponse["stagedKind"]>) {
  switch (kind) {
    case "added":
      return "A";
    case "conflicted":
      return "U";
    case "deleted":
      return "D";
    case "modified":
      return "M";
    case "renamed":
      return "R";
    case "type_changed":
      return "T";
    case "untracked":
      return "?";
  }
}

function primaryChangeKind(change: ProjectChangeEntryResponse) {
  return change.unstagedKind ?? change.stagedKind ?? "modified";
}

function changeKindSummaryCode(change: ProjectChangeEntryResponse) {
  return [change.stagedKind, change.unstagedKind]
    .filter((kind): kind is NonNullable<typeof kind> => kind !== null)
    .map(changeKindCode)
    .join("/");
}

function changeSummaryLabel(change: ProjectChangeEntryResponse) {
  return [
    change.stagedKind ? `staged ${change.stagedKind.replace("_", " ")}` : null,
    change.unstagedKind ? `unstaged ${change.unstagedKind.replace("_", " ")}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

function isUnavailableError(error: Error | null): error is BrowserApiError {
  return (
    error instanceof BrowserApiError &&
    (error.code === "path_not_found" ||
      error.code === "project_busy" ||
      error.code === "sandbox_unavailable")
  );
}
