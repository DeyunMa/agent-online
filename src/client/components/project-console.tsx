import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, CirclePause, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { isTerminalAgentRun } from "../../domain/agent-run";
import type { AgentRunResponse } from "../../shared/api";
import {
  type AgentRuntimeId,
  isSupportedAgentRuntimeId,
  type SupportedAgentRuntimeId,
} from "../../shared/protocol";
import { type BrowserApiError, browserApi, subscribeToAgentRun } from "../api";
import { deriveProjectActivity } from "../project-activity";
import { useProjectMessages, useRunHistory } from "../project-queries";
import {
  activeAgentRunQueryKey,
  agentRunQueryKey,
  agentRunsQueryKey,
  platformCapabilitiesQueryKey,
  projectChangesQueryKey,
  projectDetailQueryKey,
  projectFilesQueryKey,
  projectMessagesQueryKey,
  projectQueryKey,
  userUsageQueryKey,
} from "../query-keys";
import { AppHeaderSlot } from "./app-header-slot";
import { ProjectActionsMenu } from "./project-actions-menu";
import { type InspectorView, ProjectInspector } from "./project-inspector";
import { ProjectPanels } from "./project-panels";
import {
  AgentComposer,
  ConversationTimeline,
  type ProjectConsoleView,
  ProjectRunTabs,
  RunHistory,
  RunMetrics,
  RunStatusBar,
} from "./run-console";
import { Tabs, TabsContent } from "./ui/tabs";
import { ErrorState, LoadingState } from "./ui-states";

export function ProjectConsole({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  const isMobileInspectorViewport = useMediaQuery("(max-width: 760px)");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [healthyStreamRunId, setHealthyStreamRunId] = useState<string | null>(null);
  const synchronizedTerminalRuns = useRef(new Set<string>());
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
  const messages = useProjectMessages(projectId, project.isSuccess);
  const activeAgentRun = useQuery({
    enabled: project.isSuccess,
    queryFn: () => browserApi.getActiveAgentRun(projectId),
    queryKey: activeAgentRunQueryKey(projectId),
  });
  const recentRuns = useRunHistory(projectId, project.isSuccess);
  const runHistory = [
    ...new Map(
      recentRuns.data?.pages.flatMap((page) => page.items).map((run) => [run.id, run]) ?? [],
    ).values(),
  ];
  const agentRun = useQuery({
    enabled: activeRunId !== null,
    queryFn: () => browserApi.getAgentRun(projectId, activeRunId ?? ""),
    queryKey: agentRunQueryKey(projectId, activeRunId ?? ""),
    refetchInterval: (query) =>
      query.state.data && isTerminalAgentRun(query.state.data.status)
        ? false
        : healthyStreamRunId === activeRunId
          ? 30_000
          : 2_000,
  });

  const selectedRun = useQuery({
    enabled: selectedRunId !== null && selectedRunId !== activeRunId,
    queryFn: () => browserApi.getAgentRun(projectId, selectedRunId ?? ""),
    queryKey: agentRunQueryKey(projectId, selectedRunId ?? ""),
  });

  const createRun = useMutation({
    mutationFn: ({
      agentRuntimeId,
      content,
    }: {
      agentRuntimeId: SupportedAgentRuntimeId;
      content: string;
    }) => browserApi.createAgentRun(projectId, { agentRuntimeId, content }),
    onSuccess: async (run) => {
      setActiveRunId(run.id);
      setSelectedRunId(null);
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
      queryClient.setQueryData(
        activeAgentRunQueryKey(projectId),
        isTerminalAgentRun(run.status) ? null : run,
      );
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
  const streamingRunId =
    currentRun && !isTerminalAgentRun(currentRun.status) ? currentRun.id : null;
  const displayedRun =
    selectedRunId === null
      ? (currentRun ?? runHistory[0])
      : selectedRunId === currentRunId
        ? currentRun
        : selectedRun.data;
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
  const activeConversationRun =
    currentRun && !isTerminalAgentRun(currentRun.status)
      ? currentRun
      : recoveredActiveRun && !isTerminalAgentRun(recoveredActiveRun.status)
        ? recoveredActiveRun
        : undefined;
  const conversationIsRunning = createRun.isPending || activeConversationRun !== undefined;
  const submitAssistantTask = useCallback(
    async (content: string) => {
      if (!selectedAgentRuntimeId || !isSupportedAgentRuntimeId(selectedAgentRuntimeId)) {
        throw new Error("Select an available Agent.");
      }

      await createRun.mutateAsync({ agentRuntimeId: selectedAgentRuntimeId, content });
    },
    [createRun, selectedAgentRuntimeId],
  );
  const cancelAssistantTask = useCallback(async () => {
    if (currentRun) {
      await cancelRun.mutateAsync(currentRun.id);
    }
  }, [cancelRun, currentRun]);
  const activity = deriveProjectActivity({
    previewActive,
    previewStarting,
    runActive: activeRunIsBlocking,
    terminalActive,
  });
  const exclusiveActivityActive = activity.exclusive !== "idle";
  const composerDisabled =
    createRun.isPending ||
    runCreationUnavailable ||
    exclusiveActivityActive ||
    selectedAgentRuntimeId === null;
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
    setSelectedRunId(null);
    setHealthyStreamRunId(null);
    synchronizedTerminalRuns.current.clear();
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
    const recoveredRun = recoveredActiveRun;
    if (!recoveredRun || isTerminalAgentRun(recoveredRun.status)) {
      return;
    }

    queryClient.setQueryData(agentRunQueryKey(projectId, recoveredRun.id), recoveredRun);
    setActiveRunId((current) => current ?? recoveredRun.id);
  }, [projectId, queryClient, recoveredActiveRun]);

  useEffect(() => {
    if (
      !currentRun ||
      !isTerminalAgentRun(currentRun.status) ||
      synchronizedTerminalRuns.current.has(currentRun.id)
    )
      return;
    synchronizedTerminalRuns.current.add(currentRun.id);
    setStreamError(null);
    void invalidateProjectState(queryClient, projectId);
  }, [currentRun, projectId, queryClient]);

  useEffect(() => {
    if (!streamingRunId) return;
    setHealthyStreamRunId(null);
    return subscribeToAgentRun(projectId, streamingRunId, {
      onError: (error) => {
        setHealthyStreamRunId(null);
        setStreamError(error);
      },
      onEvent: (event) => {
        setHealthyStreamRunId(streamingRunId);
        setStreamError(null);
        if (event.type === "run.status" && !isTerminalAgentRun(event.status)) {
          queryClient.setQueryData<AgentRunResponse>(
            agentRunQueryKey(projectId, streamingRunId),
            (run) => (run ? { ...run, status: event.status } : run),
          );
          return;
        }
        // Fetch complete terminal facts before triggering the one-time refresh.
        // Both terminal events share an in-flight read instead of cancelling it.
        void queryClient.invalidateQueries(
          {
            queryKey: agentRunQueryKey(projectId, streamingRunId),
          },
          { cancelRefetch: false },
        );
      },
    });
  }, [streamingRunId, projectId, queryClient]);

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
      <ProjectPanels
        onInspectorClose={closeInspector}
        mobile={isMobileInspectorViewport}
        open={inspectorOpen}
        inspector={
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
            onClose={closeInspector}
            toggleRef={inspectorToggleRef}
            open={inspectorOpen}
            previewEnabled={platformCapabilities.data?.previewEnabled === true}
            run={currentRun}
            stopError={stopSandbox.error}
            terminalEnabled={platformCapabilities.data?.terminalEnabled === true}
            view={inspectorView}
          />
        }
      >
        <main className="project-console-main" id="project-console-main">
          <Tabs
            className="min-h-0 flex-1 gap-0"
            value={view}
            onValueChange={(value) => setView(value as ProjectConsoleView)}
          >
            <ProjectRunTabs />
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
            <TabsContent className="project-conversation-panel" value="conversation">
              <RunStatusBar
                cancelError={cancelRun.error}
                isCancelling={cancelRun.isPending}
                loadError={activeAgentRun.error ?? agentRun.error}
                onCancel={() => {
                  void cancelAssistantTask().catch(() => undefined);
                }}
                run={currentRun}
                streamError={streamError}
              />
              <ConversationTimeline
                key={projectId}
                isRunning={conversationIsRunning}
                runStatus={activeConversationRun?.status ?? null}
                hasOlder={messages.data?.nextCursor != null}
                loadingOlder={messages.older.isPending}
                onLoadOlder={() => messages.older.mutate()}
                olderError={messages.older.error}
                error={messages.error}
                isPending={messages.isPending}
                messages={messages.data?.items}
                onRetry={() => void messages.refetch()}
              />
            </TabsContent>
            <TabsContent value="runs" className="project-console-scroll project-console-runs-view">
              <RunMetrics compact run={displayedRun} />
              {recentRuns.hasNextPage ? (
                <button
                  className="secondary-action"
                  type="button"
                  disabled={recentRuns.isFetchingNextPage}
                  onClick={() => void recentRuns.fetchNextPage()}
                >
                  Load more runs
                </button>
              ) : null}
              <RunHistory
                error={recentRuns.error ?? selectedRun.error}
                isPending={recentRuns.isPending}
                messages={messages.data?.items}
                onRetry={() => void recentRuns.refetch()}
                onSelect={setSelectedRunId}
                runs={runHistory}
                selectedRunId={displayedRun?.id ?? null}
              />
            </TabsContent>
            <AgentComposer
              key={projectId}
              onSubmitText={submitAssistantTask}
              agentRuntimeIds={agentRuntimeIds}
              changesEnabled={platformCapabilities.data?.changesEnabled === true}
              disabled={composerDisabled}
              disabledReason={
                createRun.isPending
                  ? "Submitting your task…"
                  : runCreationUnavailable
                    ? "Task submission is unavailable while service capabilities are loading or paused."
                    : activity.exclusive === "terminal"
                      ? "Close Terminal before starting another task."
                      : activity.exclusive === "preview_starting"
                        ? "Wait for Preview to finish starting."
                        : activeRunIsBlocking
                          ? "Wait for the active task to finish, or cancel it."
                          : selectedAgentRuntimeId === null
                            ? "No Agent runtime is currently available."
                            : null
              }
              error={createRun.error}
              fileUploadDisabled={!fileUploadAvailable}
              isSubmitting={createRun.isPending}
              isUploadingFile={uploadFile.isPending}
              onAgentRuntimeChange={setAgentRuntimePreference}
              onChangesOpen={() => openInspectorView("changes")}
              onFilesOpen={() => openInspectorView("files")}
              onTerminalOpen={() => openInspectorView("terminal")}
              onUploadFile={(file) => uploadFile.mutateAsync(file)}
              selectedAgentRuntimeId={selectedAgentRuntimeId}
              terminalEnabled={platformCapabilities.data?.terminalEnabled === true}
              uploadError={uploadFile.error}
            />
          </Tabs>
        </main>
      </ProjectPanels>
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
