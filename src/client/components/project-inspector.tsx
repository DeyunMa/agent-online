import { LoaderCircle, Square } from "lucide-react";
import type { ReactNode } from "react";

import type {
  AgentRunResponse,
  ProjectResponse,
} from "../../shared/api";
import {
  agentRunStatusLabel,
  agentRunStatusTone,
  formatDateTime,
  formatRunDuration,
  formatTokenCount,
  sandboxStatusLabel,
  sandboxStatusTone,
  shortRunId,
} from "../presentation";
import { ErrorState } from "./ui-states";

export function ProjectInspector({
  hasActiveRun,
  isStopping,
  onStopSandbox,
  project,
  run,
  stopError,
}: {
  hasActiveRun: boolean;
  isStopping: boolean;
  onStopSandbox: () => void;
  project: ProjectResponse;
  run: AgentRunResponse | undefined;
  stopError: Error | null;
}) {
  const lease = project.sandboxLease;
  const canStop =
    lease !== null &&
    lease.status !== "stopped" &&
    !hasActiveRun &&
    !isStopping;

  return (
    <aside className="project-inspector">
      <header className="project-inspector-header">
        <h2>Project inspector</h2>
      </header>

      <div
        aria-label="Project inspector views"
        className="inspector-tabs"
        role="tablist"
      >
        <button
          aria-selected="true"
          className="inspector-tab inspector-tab-active"
          role="tab"
          type="button"
        >
          Overview
        </button>
        <DisabledInspectorTab label="Files" />
        <DisabledInspectorTab label="Terminal" />
        <DisabledInspectorTab label="Preview" />
      </div>

      <ProjectOverview project={project} run={run} />

      <section className="inspector-section">
        <h3>Sandbox</h3>
        <dl className="inspector-definition-list">
          <Definition
            label="Status"
            value={
              <span className={`status-with-dot ${sandboxStatusTone(lease?.status)}`}>
                <span aria-hidden="true" />
                {lease ? sandboxStatusLabel(lease.status) : "Not started"}
              </span>
            }
          />
          <Definition
            label="Runtime"
            value={lease ? runtimeLabel(lease.runtimeId) : "—"}
          />
          <Definition
            label="Updated"
            value={lease ? formatDateTime(lease.updatedAt) : "—"}
          />
        </dl>
        {stopError ? <ErrorState compact error={stopError} /> : null}
        {lease && lease.status !== "stopped" ? (
          <button
            className="stop-sandbox-action"
            disabled={!canStop}
            onClick={onStopSandbox}
            type="button"
          >
            {isStopping ? (
              <LoaderCircle aria-hidden="true" className="spin" size={15} />
            ) : (
              <Square aria-hidden="true" size={13} />
            )}
            <span>{isStopping ? "Stopping" : "Stop sandbox"}</span>
          </button>
        ) : null}
      </section>

      <CurrentRunUsage run={run} />
    </aside>
  );
}

function ProjectOverview({
  project,
  run,
}: {
  project: ProjectResponse;
  run: AgentRunResponse | undefined;
}) {
  return (
    <section className="inspector-section">
      <h3>Overview</h3>
      <dl className="inspector-definition-list">
        <Definition label="Project" value={project.title} />
        <Definition
          label="Default agent"
          value={runtimeLabel(project.defaultAgentRuntimeId)}
        />
        <Definition label="Model" value={run?.modelId ?? "—"} />
        <Definition label="Updated" value={formatDateTime(project.updatedAt)} />
      </dl>
    </section>
  );
}

function CurrentRunUsage({ run }: { run: AgentRunResponse | undefined }) {
  return (
    <section className="inspector-section">
      <h3>Current run</h3>
      {run ? (
        <dl className="inspector-definition-list">
          <Definition label="Run" value={shortRunId(run.id)} />
          <Definition
            label="Status"
            value={
              <span className={agentRunStatusTone(run.status)}>
                {agentRunStatusLabel(run.status)}
              </span>
            }
          />
          <Definition
            label="Model requests"
            value={String(run.usage.modelRequestCount)}
          />
          <Definition
            label="Tokens"
            value={formatTokenCount(run.usage.totalTokens)}
          />
          <Definition label="Duration" value={formatRunDuration(run)} />
        </dl>
      ) : (
        <p className="inspector-empty">No run selected.</p>
      )}
    </section>
  );
}

function Definition({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function DisabledInspectorTab({ label }: { label: string }) {
  return (
    <button
      aria-label={`${label} unavailable`}
      className="inspector-tab"
      disabled
      role="tab"
      title={`${label} is not available`}
      type="button"
    >
      {label}
    </button>
  );
}

function runtimeLabel(value: string) {
  if (value === "pi") {
    return "Pi";
  }
  if (value === "e2b") {
    return "E2B";
  }
  if (value === "fake") {
    return "Fake";
  }
  return value;
}
