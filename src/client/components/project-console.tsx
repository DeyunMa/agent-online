import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, CirclePause, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { isTerminalAgentRun } from "../../domain/agent-run";
import type { AgentRunResponse } from "../../shared/api";
import type { AgentRuntimeId } from "../../shared/protocol";
import { type BrowserApiError, browserApi, subscribeToAgentRun } from "../api";
import { deriveProjectActivity } from "../project-activity";
import {
  activeAgentRunQueryKey,
  agentRunQueryKey,
  agentRunsQueryKey,
  projectDetailQueryKey,
  projectChangesQueryKey,
  projectFilesQueryKey,
  projectMessagesQueryKey,
  projectQueryKey,
  platformCapabilitiesQueryKey,
  userUsageQueryKey,
} from "../query-keys";
import { ProjectInspector, type InspectorView } from "./project-inspector";
import { ProjectPanelResizer } from "./project-panel-resizer";
import {
  AgentComposer,
  ConversationTimeline,
  ProjectRunTabs,
  RunHistory,
  RunMetrics,
  RunStatusBar,
  type ProjectConsoleView,
} from "./run-console";
import { ErrorState, LoadingState } from "./ui-states";
import { AppHeaderSlot } from "./app-header-slot";
import { ProjectActionsMenu } from "./project-actions-menu";

export function ProjectConsole({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const consoleRef = useRef<HTMLElement>(null);
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  const isMobileInspectorViewport = useMediaQuery("(max-width: 760px)");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<BrowserApiError | null>(null);
  const [previewActive, setPreviewActive] = useState(false);
  const [previewStarting, setPreviewStarting] = useState(false);
  const [terminalActive, setTerminalActive] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorView, setInspectorView] = useState<InspectorView>("overview");
  const [filesRevision, setFilesRevision] = useState(0);
  const [agentRuntimePreference, setAgentRuntimePreference] = useState<AgentRuntimeId | null>(null);
  const [view, setView] = useState<ProjectConsoleView>("conversation");
  const mobileInspectorOpen = inspectorOpen && isMobileInspectorViewport;
  const openInspectorView = useCallback((nextView: InspectorView) => {
    setInspectorView(nextView);
    setInspectorOpen(true);
  }, []);

  const project = useQuery({
    queryFn: () => browserApi.getProject(projectId),
    queryKey: projectDetailQueryKey(projectId),
  });
  const platformCapabilities = useQuery({
    queryFn: browserApi.getPlatformCapabilities,
    queryKey: platformCapabilitiesQueryKey,
    staleTime: 30_000,
  });
  const messages = useQuery({
    enabled: project.isSuccess,
    queryFn: () => browserApi.listMessages(projectId),
    queryKey: projectMessagesQueryKey(projectId),
  });
  const activeAgentRun = useQuery({
    enabled: project.isSuccess,
    queryFn: () => browserApi.getActiveAgentRun(projectId),
    queryKey: activeAgentRunQueryKey(projectId),
  });
  const recentRuns = useQuery({
    enabled: project.isSuccess,
    queryFn: () => browserApi.listAgentRuns(projectId),
    queryKey: agentRunsQueryKey(projectId),
  });
  const agentRun = useQuery({
    enabled: activeRunId !== null,
    queryFn: () => browserApi.getAgentRun(projectId, activeRunId ?? ""),
    queryKey: agentRunQueryKey(projectId, activeRunId ?? ""),
    refetchInterval: (query) =>
      query.state.data && isTerminalAgentRun(query.state.data.status) ? false : 2_000,
  });

  const createRun = useMutation({
    mutationFn: ({
      agentRuntimeId,
      content,
    }: {
      agentRuntimeId: AgentRuntimeId;
      content: string;
    }) => browserApi.createAgentRun(projectId, { agentRuntimeId, content }),
    onSuccess: async (run) => {
      setActiveRunId(run.id);
      setStreamError(null);
      setView("conversation");
      queryClient.setQueryData(agentRunQueryKey(projectId, run.id), run);
      queryClient.setQueryData(activeAgentRunQueryKey(projectId), run);
      await invalidateProjectState(queryClient, projectId);
    },
  });
  const cancelRun = useMutation({
    mutationFn: (runId: string) => browserApi.cancelAgentRun(projectId, runId),
    onSuccess: async (run) => {
      queryClient.setQueryData(agentRunQueryKey(projectId, run.id), run);
      await invalidateProjectState(queryClient, projectId);
    },
  });
  const uploadFile = useMutation({
    mutationFn: (file: File) => browserApi.uploadProjectFile(projectId, file),
    onSuccess: async () => {
      setFilesRevision((revision) => revision + 1);
      openInspectorView("files");
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: projectFilesQueryKey(projectId, ""),
        }),
        queryClient.invalidateQueries({
          queryKey: projectChangesQueryKey(projectId),
        }),
      ]);
    },
  });
  const stopSandbox = useMutation({
    mutationFn: () => browserApi.stopProjectSandbox(projectId),
    onSuccess: async (updatedProject) => {
      queryClient.setQueryData(projectDetailQueryKey(projectId), updatedProject);
      await queryClient.invalidateQueries({ queryKey: projectQueryKey });
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: projectDetailQueryKey(projectId),
      });
    },
  });

  const currentRun = agentRun.data;
  const currentRunId = currentRun?.id ?? null;
  const recoveredActiveRun = activeAgentRun.data;
  const activeRunIsBlocking =
    activeAgentRun.isPending ||
    (recoveredActiveRun !== null &&
      recoveredActiveRun !== undefined &&
      !isTerminalAgentRun(recoveredActiveRun.status)) ||
    (activeRunId !== null && (currentRun === undefined || !isTerminalAgentRun(currentRun.status)));
  const runCreationUnavailable =
    platformCapabilities.isPending ||
    platformCapabilities.isError ||
    !platformCapabilities.data.runCreationEnabled;
  const agentRuntimeIds = platformCapabilities.data?.agentRuntimeIds ?? [];
  const selectedAgentRuntimeId =
    agentRuntimePreference && agentRuntimeIds.includes(agentRuntimePreference)
      ? agentRuntimePreference
      : platformCapabilities.data &&
          agentRuntimeIds.includes(platformCapabilities.data.defaultAgentRuntimeId)
        ? platformCapabilities.data.defaultAgentRuntimeId
        : null;
  const activity = deriveProjectActivity({
    previewActive,
    previewStarting,
    runActive: activeRunIsBlocking,
    terminalActive,
  });
  const exclusiveActivityActive = activity.exclusive !== "idle";
  const sandboxLease = project.data?.sandboxLease;
  const fileUploadAvailable =
    platformCapabilities.data?.fileUploadEnabled === true &&
    sandboxLease !== null &&
    sandboxLease !== undefined &&
    (sandboxLease.status === "idle" || sandboxLease.status === "ready") &&
    !exclusiveActivityActive;
  const closeInspector = useCallback(() => {
    inspectorToggleRef.current?.focus({ preventScroll: true });
    setInspectorOpen(false);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Project identity intentionally resets console-local state.
  useEffect(() => {
    setActiveRunId(null);
    setStreamError(null);
    setPreviewActive(false);
    setPreviewStarting(false);
    setTerminalActive(false);
    setInspectorOpen(false);
    setInspectorView("overview");
    setFilesRevision(0);
    setAgentRuntimePreference(null);
    setView("conversation");
    uploadFile.reset();
  }, [projectId]);

  useEffect(() => {
    if (!inspectorOpen) {
      return;
    }

    function handleInspectorKeyDown(event: KeyboardEvent) {
      const target = event.target;
      const terminalOwnsEscape =
        target instanceof Element && target.closest(".project-terminal-view") !== null;
      if (event.key === "Escape" && !event.defaultPrevented && !terminalOwnsEscape) {
        closeInspector();
      }
    }

    window.addEventListener("keydown", handleInspectorKeyDown);
    return () => window.removeEventListener("keydown", handleInspectorKeyDown);
  }, [closeInspector, inspectorOpen]);

  useEffect(() => {
    const recoveredRun = recoveredActiveRun;
    if (!recoveredRun || isTerminalAgentRun(recoveredRun.status)) {
      return;
    }

    queryClient.setQueryData(agentRunQueryKey(projectId, recoveredRun.id), recoveredRun);
    setActiveRunId((current) => current ?? recoveredRun.id);
  }, [projectId, queryClient, recoveredActiveRun]);

  useEffect(() => {
    if (activeRunId !== null || !activeAgentRun.isSuccess || activeAgentRun.data !== null) {
      return;
    }

    const latestRun = recentRuns.data?.[0];
    if (latestRun) {
      queryClient.setQueryData(agentRunQueryKey(projectId, latestRun.id), latestRun);
      setActiveRunId(latestRun.id);
    }
  }, [
    activeAgentRun.data,
    activeAgentRun.isSuccess,
    activeRunId,
    projectId,
    queryClient,
    recentRuns.data,
  ]);

  useEffect(() => {
    if (!currentRun || !isTerminalAgentRun(currentRun.status)) {
      return;
    }

    setStreamError(null);
    void invalidateProjectState(queryClient, projectId);
  }, [currentRun, projectId, queryClient]);

  useEffect(() => {
    if (!currentRunId || isTerminalAgentRun(currentRun?.status ?? "succeeded")) {
      return;
    }

    return subscribeToAgentRun(projectId, currentRunId, {
      onError: setStreamError,
      onEvent: (event) => {
        if (event.type === "run.status") {
          queryClient.setQueryData<AgentRunResponse>(
            agentRunQueryKey(projectId, currentRunId),
            (run) => (run ? { ...run, status: event.status } : run),
          );
          if (isTerminalAgentRun(event.status)) {
            setStreamError(null);
            void invalidateProjectState(queryClient, projectId);
          }
          return;
        }

        if (event.type === "run.completed") {
          queryClient.setQueryData<AgentRunResponse>(
            agentRunQueryKey(projectId, currentRunId),
            (run) => (run ? { ...run, usage: event.usage } : run),
          );
          setStreamError(null);
          void queryClient.invalidateQueries({
            queryKey: agentRunQueryKey(projectId, currentRunId),
          });
          void invalidateProjectState(queryClient, projectId);
        }
      },
    });
  }, [currentRun?.status, currentRunId, projectId, queryClient]);

  if (project.isPending) {
    return <LoadingState label="Loading project" />;
  }

  if (project.isError) {
    return (
      <section className="project-console-error">
        <ErrorState error={project.error} onRetry={() => void project.refetch()} />
      </section>
    );
  }

  return (
    <>
      <AppHeaderSlot>
        <div className="project-console-header">
          <nav aria-label="Breadcrumb" className="project-breadcrumb">
            <Link to="/">Projects</Link>
            <ChevronRight aria-hidden="true" size={14} />
            <span>{project.data.title}</span>
            <ChevronRight aria-hidden="true" size={14} />
            <strong>Agent run</strong>
          </nav>
          <div className="project-console-header-actions">
            <ProjectActionsMenu placement="header" project={project.data} />
            <button
              aria-expanded={inspectorOpen}
              aria-label={inspectorOpen ? "Close project inspector" : "Open project inspector"}
              className="icon-button project-inspector-toggle"
              onClick={() => setInspectorOpen((open) => !open)}
              ref={inspectorToggleRef}
              title={inspectorOpen ? "Close project inspector" : "Open project inspector"}
              type="button"
            >
              {inspectorOpen ? (
                <PanelRightClose aria-hidden="true" size={17} />
              ) : (
                <PanelRightOpen aria-hidden="true" size={17} />
              )}
            </button>
          </div>
        </div>
      </AppHeaderSlot>
      <section
        className={
          inspectorOpen ? "project-console project-console-inspector-open" : "project-console"
        }
        ref={consoleRef}
      >
        <main className="project-console-main" id="project-console-main">
          <ProjectRunTabs onViewChange={setView} view={view} />
          {platformCapabilities.isError ? (
            <div className="run-availability">
              <ErrorState
                compact
                error={platformCapabilities.error}
                onRetry={() => void platformCapabilities.refetch()}
              />
            </div>
          ) : null}
          {platformCapabilities.data?.runCreationEnabled === false ? (
            <div className="run-availability run-availability-paused" role="status">
              <CirclePause aria-hidden="true" size={15} />
              <span>New Agent Runs are temporarily paused.</span>
            </div>
          ) : null}
          {view === "conversation" ? (
            <>
              <RunStatusBar
                cancelError={cancelRun.error}
                isCancelling={cancelRun.isPending}
                loadError={activeAgentRun.error ?? agentRun.error}
                onCancel={() => {
                  if (currentRun) {
                    cancelRun.mutate(currentRun.id);
                  }
                }}
                run={currentRun}
                streamError={streamError}
              />
              <div className="project-console-scroll">
                <ConversationTimeline
                  error={messages.error}
                  isPending={messages.isPending}
                  messages={messages.data}
                  onRetry={() => void messages.refetch()}
                />
              </div>
            </>
          ) : (
            <div className="project-console-scroll project-console-runs-view">
              <RunMetrics compact run={currentRun} />
              <RunHistory
                error={recentRuns.error}
                isPending={recentRuns.isPending}
                messages={messages.data}
                onRetry={() => void recentRuns.refetch()}
                onSelect={(runId) => {
                  setActiveRunId(runId);
                }}
                runs={recentRuns.data}
                selectedRunId={currentRunId}
              />
            </div>
          )}
          <AgentComposer
            agentRuntimeIds={agentRuntimeIds}
            disabled={
              createRun.isPending ||
              runCreationUnavailable ||
              exclusiveActivityActive ||
              selectedAgentRuntimeId === null
            }
            error={createRun.error}
            fileUploadDisabled={!fileUploadAvailable}
            isSubmitting={createRun.isPending}
            isUploadingFile={uploadFile.isPending}
            onChangesOpen={() => openInspectorView("changes")}
            onAgentRuntimeChange={setAgentRuntimePreference}
            onFilesOpen={() => openInspectorView("files")}
            onSubmit={(content, agentRuntimeId) =>
              createRun.mutateAsync({ agentRuntimeId, content })
            }
            onTerminalOpen={() => openInspectorView("terminal")}
            onUploadFile={(file) => uploadFile.mutateAsync(file)}
            selectedAgentRuntimeId={selectedAgentRuntimeId}
            changesEnabled={platformCapabilities.data?.changesEnabled === true}
            terminalEnabled={platformCapabilities.data?.terminalEnabled === true}
            uploadError={uploadFile.error}
          />
        </main>

        <ProjectPanelResizer containerRef={consoleRef} open={inspectorOpen} />
        {mobileInspectorOpen ? (
          <button
            aria-label="Dismiss project inspector"
            className="project-inspector-backdrop"
            onClick={closeInspector}
            type="button"
          />
        ) : null}
        <ProjectInspector
          activity={activity}
          changesEnabled={platformCapabilities.data?.changesEnabled === true}
          filesRevision={filesRevision}
          isStopping={stopSandbox.isPending}
          onStopSandbox={() => stopSandbox.mutate()}
          onViewChange={setInspectorView}
          onPreviewActivityChange={setPreviewActive}
          onPreviewStartingChange={setPreviewStarting}
          onTerminalActivityChange={(active) => {
            setTerminalActive(active);
            if (!active) {
              void queryClient.invalidateQueries({
                queryKey: projectChangesQueryKey(projectId),
              });
              void queryClient.invalidateQueries({
                queryKey: projectDetailQueryKey(projectId),
              });
            }
          }}
          project={project.data}
          mobileOpen={mobileInspectorOpen}
          open={inspectorOpen}
          previewEnabled={platformCapabilities.data?.previewEnabled === true}
          run={currentRun}
          stopError={stopSandbox.error}
          terminalEnabled={platformCapabilities.data?.terminalEnabled === true}
          view={inspectorView}
        />
      </section>
    </>
  );
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    function updateMatches(event: MediaQueryListEvent) {
      setMatches(event.matches);
    }

    setMatches(media.matches);
    media.addEventListener("change", updateMatches);
    return () => media.removeEventListener("change", updateMatches);
  }, [query]);

  return matches;
}

async function invalidateProjectState(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
) {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: activeAgentRunQueryKey(projectId),
    }),
    queryClient.invalidateQueries({ queryKey: agentRunsQueryKey(projectId) }),
    queryClient.invalidateQueries({
      queryKey: projectMessagesQueryKey(projectId),
    }),
    queryClient.invalidateQueries({
      queryKey: projectDetailQueryKey(projectId),
    }),
    queryClient.invalidateQueries({
      queryKey: projectChangesQueryKey(projectId),
    }),
    queryClient.invalidateQueries({ queryKey: userUsageQueryKey }),
  ]);
}
