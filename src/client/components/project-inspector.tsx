import { LoaderCircle, Square, X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type {
  AgentRunResponse,
  ProjectResponse,
} from "../../shared/api";
import { isActiveSandboxLease } from "../../domain/sandbox-lease";
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
import { ProjectChanges } from "./project-changes";
import { ProjectFiles } from "./project-files";
import { ProjectPreview } from "./project-preview";
import { ProjectTerminal } from "./project-terminal";

type InspectorView =
  | "changes"
  | "files"
  | "overview"
  | "preview"
  | "terminal";

export function ProjectInspector({
  changesEnabled,
  hasActiveRun,
  isStopping,
  mobileOpen,
  onMobileClose,
  onStopSandbox,
  onPreviewActivityChange,
  onPreviewStartingChange,
  onTerminalActivityChange,
  previewActive,
  previewEnabled,
  previewStarting,
  project,
  run,
  stopError,
  terminalActive,
  terminalEnabled,
}: {
  changesEnabled: boolean;
  hasActiveRun: boolean;
  isStopping: boolean;
  mobileOpen: boolean;
  onMobileClose(): void;
  onStopSandbox: () => void;
  onPreviewActivityChange(active: boolean): void;
  onPreviewStartingChange(starting: boolean): void;
  onTerminalActivityChange(active: boolean): void;
  previewActive: boolean;
  previewEnabled: boolean;
  previewStarting: boolean;
  project: ProjectResponse;
  run: AgentRunResponse | undefined;
  stopError: Error | null;
  terminalActive: boolean;
  terminalEnabled: boolean;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const [view, setView] = useState<InspectorView>("overview");
  useEffect(() => {
    if (!changesEnabled && view === "changes") {
      setView("overview");
    }
  }, [changesEnabled, view]);
  useEffect(() => {
    if (!terminalEnabled && view === "terminal") {
      setView("overview");
    }
  }, [terminalEnabled, view]);
  useEffect(() => {
    if (!previewEnabled && view === "preview") {
      setView("overview");
    }
  }, [previewEnabled, view]);
  useEffect(() => {
    if (!mobileOpen) {
      return;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      closeButtonRef.current?.focus({ preventScroll: true });
    });
    function handleTab(event: KeyboardEvent) {
      trapMobileInspectorFocus(event, inspectorRef.current);
    }
    document.addEventListener("keydown", handleTab);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleTab);
    };
  }, [mobileOpen]);
  const lease = project.sandboxLease;
  const canStop =
    lease !== null &&
    lease.status !== "stopped" &&
    !hasActiveRun &&
    !previewActive &&
    !terminalActive &&
    !isStopping;

  return (
    <aside
      aria-labelledby="project-inspector-title"
      aria-modal={mobileOpen || undefined}
      className={`project-inspector ${mobileOpen ? "project-inspector-mobile-open" : ""}`}
      ref={inspectorRef}
      role={mobileOpen ? "dialog" : undefined}
    >
      <header className="project-inspector-header">
        <h2 id="project-inspector-title">Project inspector</h2>
        {mobileOpen ? (
          <button
            aria-label="Close project inspector"
            className="icon-button project-inspector-close"
            onClick={onMobileClose}
            ref={closeButtonRef}
            title="Close project inspector"
            type="button"
          >
            <X aria-hidden="true" size={17} />
          </button>
        ) : null}
      </header>

      <div
        aria-label="Project inspector views"
        className="inspector-tabs"
        role="tablist"
      >
        <button
          aria-selected={view === "overview"}
          className={`inspector-tab ${view === "overview" ? "inspector-tab-active" : ""}`}
          onClick={() => setView("overview")}
          role="tab"
          type="button"
        >
          Overview
        </button>
        <button
          aria-selected={view === "files"}
          className={`inspector-tab ${view === "files" ? "inspector-tab-active" : ""}`}
          onClick={() => setView("files")}
          role="tab"
          type="button"
        >
          Files
        </button>
        {changesEnabled ? (
          <button
            aria-selected={view === "changes"}
            className={`inspector-tab ${view === "changes" ? "inspector-tab-active" : ""}`}
            onClick={() => setView("changes")}
            role="tab"
            type="button"
          >
            Changes
          </button>
        ) : (
          <DisabledInspectorTab label="Changes" />
        )}
        {terminalEnabled ? (
          <button
            aria-selected={view === "terminal"}
            className={`inspector-tab ${view === "terminal" ? "inspector-tab-active" : ""}`}
            onClick={() => setView("terminal")}
            role="tab"
            type="button"
          >
            Terminal
          </button>
        ) : (
          <DisabledInspectorTab label="Terminal" />
        )}
        {previewEnabled ? (
          <button
            aria-selected={view === "preview"}
            className={`inspector-tab ${view === "preview" ? "inspector-tab-active" : ""}`}
            onClick={() => setView("preview")}
            role="tab"
            type="button"
          >
            Preview
          </button>
        ) : (
          <DisabledInspectorTab label="Preview" />
        )}
      </div>

      {view === "overview" ? (
        <>
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
        </>
      ) : view === "files" ? (
        <ProjectFiles
          hasActiveRun={hasActiveRun || terminalActive}
          projectId={project.id}
          sandboxAvailable={
            lease !== null && isActiveSandboxLease(lease.status)
          }
        />
      ) : view === "changes" ? (
        <ProjectChanges
          projectBusy={hasActiveRun || terminalActive}
          projectId={project.id}
          sandboxAvailable={
            lease !== null && isActiveSandboxLease(lease.status)
          }
        />
      ) : null}
      {terminalEnabled ? (
        <ProjectTerminal
          active={view === "terminal"}
          hasActiveRun={hasActiveRun || previewStarting}
          onActivityChange={onTerminalActivityChange}
          projectId={project.id}
        />
      ) : null}
      {previewEnabled ? (
        <ProjectPreview
          active={view === "preview"}
          onActivityChange={onPreviewActivityChange}
          onStartingChange={onPreviewStartingChange}
          projectBusy={hasActiveRun || terminalActive}
          projectId={project.id}
          sandboxAvailable={
            lease !== null && isActiveSandboxLease(lease.status)
          }
        />
      ) : null}
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

function trapMobileInspectorFocus(
  event: KeyboardEvent,
  inspector: HTMLElement | null,
) {
  if (event.key !== "Tab" || !inspector) {
    return;
  }

  const focusable = Array.from(
    inspector.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getClientRects().length > 0);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) {
    event.preventDefault();
    return;
  }

  const current = document.activeElement;
  if (event.shiftKey && (current === first || !inspector.contains(current))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && current === last) {
    event.preventDefault();
    first.focus();
  }
}
