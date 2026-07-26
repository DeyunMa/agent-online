import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isTerminalAgentRun } from "../../domain/agent-run";
import type { AgentRunResponse } from "../../shared/api";
import {
  BrowserApiError,
  browserApi,
  subscribeToAgentRun,
} from "../api";
import {
  activeAgentRunQueryKey,
  agentRunQueryKey,
  agentRunsQueryKey,
  projectDetailQueryKey,
  projectMessagesQueryKey,
  projectQueryKey,
} from "../query-keys";
import { ProjectInspector } from "./project-inspector";
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

export function ProjectConsole({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [streamOutput, setStreamOutput] = useState("");
  const [streamError, setStreamError] = useState<BrowserApiError | null>(null);
  const [view, setView] = useState<ProjectConsoleView>("conversation");

  const project = useQuery({
    queryFn: () => browserApi.getProject(projectId),
    queryKey: projectDetailQueryKey(projectId),
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
      query.state.data && isTerminalAgentRun(query.state.data.status)
        ? false
        : 2_000,
  });

  const createRun = useMutation({
    mutationFn: (content: string) =>
      browserApi.createAgentRun(projectId, { content }),
    onSuccess: async (run) => {
      setActiveRunId(run.id);
      setStreamOutput("");
      setStreamError(null);
      setView("conversation");
      queryClient.setQueryData(agentRunQueryKey(projectId, run.id), run);
      queryClient.setQueryData(activeAgentRunQueryKey(projectId), run);
      await invalidateProjectState(queryClient, projectId);
    },
  });
  const cancelRun = useMutation({
    mutationFn: (runId: string) =>
      browserApi.cancelAgentRun(projectId, runId),
    onSuccess: async (run) => {
      queryClient.setQueryData(agentRunQueryKey(projectId, run.id), run);
      await invalidateProjectState(queryClient, projectId);
    },
  });
  const stopSandbox = useMutation({
    mutationFn: () => browserApi.stopProjectSandbox(projectId),
    onSuccess: async (updatedProject) => {
      queryClient.setQueryData(
        projectDetailQueryKey(projectId),
        updatedProject,
      );
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
    (activeRunId !== null &&
      (currentRun === undefined || !isTerminalAgentRun(currentRun.status)));

  useEffect(() => {
    setActiveRunId(null);
    setStreamOutput("");
    setStreamError(null);
    setView("conversation");
  }, [projectId]);

  useEffect(() => {
    const recoveredRun = recoveredActiveRun;
    if (!recoveredRun || isTerminalAgentRun(recoveredRun.status)) {
      return;
    }

    queryClient.setQueryData(
      agentRunQueryKey(projectId, recoveredRun.id),
      recoveredRun,
    );
    setActiveRunId((current) => current ?? recoveredRun.id);
  }, [projectId, queryClient, recoveredActiveRun]);

  useEffect(() => {
    if (
      activeRunId !== null ||
      !activeAgentRun.isSuccess ||
      activeAgentRun.data !== null
    ) {
      return;
    }

    const latestRun = recentRuns.data?.[0];
    if (latestRun) {
      queryClient.setQueryData(
        agentRunQueryKey(projectId, latestRun.id),
        latestRun,
      );
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
  }, [currentRun?.id, currentRun?.status, projectId, queryClient]);

  useEffect(() => {
    if (!currentRunId || isTerminalAgentRun(currentRun?.status ?? "succeeded")) {
      return;
    }

    return subscribeToAgentRun(projectId, currentRunId, {
      onError: setStreamError,
      onEvent: (event) => {
        if (event.type === "agent.output") {
          setStreamOutput((output) => `${output}${event.chunk}`);
          return;
        }

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
          setStreamOutput("");
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
        <ErrorState
          error={project.error}
          onRetry={() => void project.refetch()}
        />
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
          <button
            className="new-run-action"
            disabled={activeRunIsBlocking}
            onClick={() => composerRef.current?.focus()}
            type="button"
          >
            <Plus aria-hidden="true" size={16} />
            <span>New run</span>
          </button>
        </div>
      </AppHeaderSlot>
      <section className="project-console">
      <main className="project-console-main">
        <ProjectRunTabs onViewChange={setView} view={view} />
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
            <RunMetrics run={currentRun} />
            <div className="project-console-scroll">
              <ConversationTimeline
                error={messages.error}
                isPending={messages.isPending}
                messages={messages.data}
                onRetry={() => void messages.refetch()}
                streamOutput={streamOutput}
              />
              <RunHistory
                error={recentRuns.error}
                isPending={recentRuns.isPending}
                messages={messages.data}
                onRetry={() => void recentRuns.refetch()}
                onSelect={(runId) => {
                  setActiveRunId(runId);
                  setStreamOutput("");
                  setStreamError(null);
                }}
                runs={recentRuns.data}
                selectedRunId={currentRunId}
              />
            </div>
          </>
        ) : (
          <div className="project-console-scroll project-console-runs-view">
            <RunHistory
              error={recentRuns.error}
              isPending={recentRuns.isPending}
              messages={messages.data}
              onRetry={() => void recentRuns.refetch()}
              onSelect={(runId) => {
                setActiveRunId(runId);
                setView("conversation");
              }}
              runs={recentRuns.data}
              selectedRunId={currentRunId}
            />
          </div>
        )}
        <AgentComposer
          disabled={createRun.isPending || activeRunIsBlocking}
          error={createRun.error}
          isSubmitting={createRun.isPending}
          onSubmit={(content) => createRun.mutateAsync(content)}
          textareaRef={composerRef}
        />
      </main>

      <ProjectInspector
        hasActiveRun={activeRunIsBlocking}
        isStopping={stopSandbox.isPending}
        onStopSandbox={() => stopSandbox.mutate()}
        project={project.data}
        run={currentRun}
        stopError={stopSandbox.error}
      />
      </section>
    </>
  );
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
  ]);
}
