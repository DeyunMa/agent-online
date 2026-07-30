import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Monitor, Play, RefreshCw, Square } from "lucide-react";
import { useEffect, useState } from "react";

import type { ProjectPreviewResponse } from "../../shared/api";
import { browserApi } from "../api";
import { projectPreviewQueryKey } from "../query-keys";
import { ErrorState, LoadingState } from "./ui-states";

export function ProjectPreview({
  active,
  onActivityChange,
  onStartingChange,
  projectBusy,
  projectId,
  sandboxAvailable,
}: {
  active: boolean;
  onActivityChange(active: boolean): void;
  onStartingChange(starting: boolean): void;
  projectBusy: boolean;
  projectId: string;
  sandboxAvailable: boolean;
}) {
  const queryClient = useQueryClient();
  const [reloadVersion, setReloadVersion] = useState(0);
  const preview = useQuery({
    queryFn: () => browserApi.getProjectPreview(projectId),
    queryKey: projectPreviewQueryKey(projectId),
    refetchInterval: (query) =>
      query.state.data?.status === "running" || query.state.data?.status === "starting"
        ? 5_000
        : false,
    retry: false,
  });
  const start = useMutation({
    mutationFn: () => browserApi.startProjectPreview(projectId),
    onSuccess: (status) => {
      queryClient.setQueryData(projectPreviewQueryKey(projectId), status);
      setReloadVersion((version) => version + 1);
    },
  });
  const stop = useMutation({
    mutationFn: () => browserApi.stopProjectPreview(projectId),
    onSuccess: (status) => {
      queryClient.setQueryData(projectPreviewQueryKey(projectId), status);
    },
  });
  const status = preview.data?.status ?? "stopped";
  const mutationError = start.error ?? stop.error;
  const starting = start.isPending || status === "starting";
  const activity = starting || status === "running";

  // biome-ignore lint/correctness/useExhaustiveDependencies: Project identity must release the previous activity signal.
  useEffect(() => {
    onActivityChange(activity);
    return () => onActivityChange(false);
  }, [activity, onActivityChange, projectId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Project identity must release the previous starting signal.
  useEffect(() => {
    onStartingChange(starting);
    return () => onStartingChange(false);
  }, [onStartingChange, projectId, starting]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Project identity intentionally resets reload state.
  useEffect(() => {
    setReloadVersion(0);
  }, [projectId]);

  return (
    <section className="project-preview-view" hidden={!active}>
      <div className="project-preview-toolbar">
        <PreviewStatus pending={start.isPending || stop.isPending} status={status} />
        <div className="project-preview-actions">
          {status === "running" ? (
            <button
              aria-label="Reload preview"
              className="project-preview-icon-action"
              disabled={stop.isPending}
              onClick={() => setReloadVersion((version) => version + 1)}
              title="Reload preview"
              type="button"
            >
              <RefreshCw aria-hidden="true" size={14} />
            </button>
          ) : null}
          {status === "running" ? (
            <button
              className="project-preview-action"
              disabled={stop.isPending}
              onClick={() => stop.mutate()}
              type="button"
            >
              {stop.isPending ? (
                <LoaderCircle aria-hidden="true" className="spin" size={14} />
              ) : (
                <Square aria-hidden="true" size={12} />
              )}
              <span>{stop.isPending ? "Stopping" : "Stop"}</span>
            </button>
          ) : (
            <button
              className="project-preview-action"
              disabled={
                !sandboxAvailable || projectBusy || start.isPending || status === "starting"
              }
              onClick={() => start.mutate()}
              type="button"
            >
              {start.isPending || status === "starting" ? (
                <LoaderCircle aria-hidden="true" className="spin" size={14} />
              ) : (
                <Play aria-hidden="true" size={13} />
              )}
              <span>{start.isPending || status === "starting" ? "Starting" : "Start"}</span>
            </button>
          )}
        </div>
      </div>

      {preview.isPending ? (
        <LoadingState label="Loading preview status" />
      ) : preview.error ? (
        <ErrorState compact error={preview.error} onRetry={() => void preview.refetch()} />
      ) : mutationError ? (
        <ErrorState
          compact
          error={mutationError}
          onRetry={() => {
            start.reset();
            stop.reset();
            void preview.refetch();
          }}
        />
      ) : null}

      {active && status === "running" && preview.data?.contentUrl ? (
        <iframe
          className="project-preview-frame"
          key={`${preview.data.contentUrl}:${reloadVersion}`}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts"
          src={preview.data.contentUrl}
          title="Project preview"
        />
      ) : preview.isSuccess && !mutationError ? (
        <PreviewNotice
          projectBusy={projectBusy}
          sandboxAvailable={sandboxAvailable}
          status={status}
        />
      ) : null}
    </section>
  );
}

function PreviewStatus({
  pending,
  status,
}: {
  pending: boolean;
  status: ProjectPreviewResponse["status"];
}) {
  const label = pending
    ? "Updating"
    : status === "running"
      ? "Running"
      : status === "starting"
        ? "Starting"
        : "Stopped";
  return (
    <span className={`project-preview-status preview-status-${status}`} role="status">
      <span aria-hidden="true" />
      {label}
    </span>
  );
}

function PreviewNotice({
  projectBusy,
  sandboxAvailable,
  status,
}: {
  projectBusy: boolean;
  sandboxAvailable: boolean;
  status: ProjectPreviewResponse["status"];
}) {
  return (
    <div className="project-preview-notice">
      <Monitor aria-hidden="true" size={18} />
      <div>
        <strong>
          {status === "starting"
            ? "Preview is starting"
            : projectBusy
              ? "Project is busy"
              : sandboxAvailable
                ? "Preview is stopped"
                : "Sandbox not started"}
        </strong>
        <span>
          {status === "starting"
            ? "Waiting for the fixed development port."
            : projectBusy
              ? "Finish the current run or terminal session first."
              : sandboxAvailable
                ? "Start the current project preview."
                : "Run the agent once before starting Preview."}
        </span>
      </div>
    </div>
  );
}
