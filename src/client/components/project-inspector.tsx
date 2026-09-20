import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { LoaderCircle, Square } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { isActiveSandboxLease } from "../../domain/sandbox-lease";
import type { AgentRunResponse, ProjectResponse } from "../../shared/api";
import { cn } from "../lib/utils";
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
import type { ProjectActivity } from "../project-activity";
import { ProjectChanges } from "./project-changes";
import { ProjectFiles } from "./project-files";
import { ProjectPreview } from "./project-preview";
import { ProjectTerminal } from "./project-terminal";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { ErrorState } from "./ui-states";

export type InspectorView = "changes" | "files" | "overview" | "preview" | "terminal";

export function ProjectInspector({
  activity,
  changesEnabled,
  filesRevision,
  isStopping,
  mobileOpen,
  onClose,
  toggleRef,
  onViewChange,
  onStopSandbox,
  onPreviewActivityChange,
  onPreviewStartingChange,
  onTerminalActivityChange,
  previewEnabled,
  project,
  run,
  stopError,
  terminalEnabled,
  view,
  open,
}: {
  activity: ProjectActivity;
  changesEnabled: boolean;
  filesRevision: number;
  isStopping: boolean;
  mobileOpen: boolean;
  onClose(): void;
  toggleRef: RefObject<HTMLButtonElement | null>;
  onStopSandbox: () => void;
  onPreviewActivityChange(active: boolean): void;
  onPreviewStartingChange(starting: boolean): void;
  onTerminalActivityChange(active: boolean): void;
  onViewChange(view: InspectorView): void;
  previewEnabled: boolean;
  project: ProjectResponse;
  run: AgentRunResponse | undefined;
  stopError: Error | null;
  terminalEnabled: boolean;
  view: InspectorView;
  open: boolean;
}) {
  const inspectorRef = useRef<HTMLDivElement>(null);
  // An explicit null container makes Base UI wait for the host. A ref whose current
  // value is still null during child layout effects would fall back to document.body.
  const [portalHost, setPortalHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!changesEnabled && view === "changes") {
      onViewChange("overview");
    }
  }, [changesEnabled, onViewChange, view]);
  useEffect(() => {
    if (!terminalEnabled && view === "terminal") {
      onViewChange("overview");
    }
  }, [onViewChange, terminalEnabled, view]);
  useEffect(() => {
    if (!previewEnabled && view === "preview") {
      onViewChange("overview");
    }
  }, [onViewChange, previewEnabled, view]);
  const lease = project.sandboxLease;
  const hasActiveRun = activity.exclusive === "run";
  const terminalActive = activity.exclusive === "terminal";
  const previewStarting = activity.preview === "starting";
  const previewActive = activity.preview !== "stopped";
  const canStop =
    lease !== null &&
    lease.status !== "stopped" &&
    !hasActiveRun &&
    !previewActive &&
    !terminalActive &&
    !isStopping;
  return (
    <div ref={setPortalHost} className="project-inspector-host">
      <DialogPrimitive.Root
        open={open}
        modal={mobileOpen}
        onOpenChange={(nextOpen, details) => {
          if (nextOpen) return;
          const target = details.event.target;
          if (
            (!mobileOpen && details.reason === "outside-press") ||
            (details.reason === "escape-key" &&
              target instanceof Element &&
              target.closest(".project-terminal-view"))
          ) {
            details.cancel();
            return;
          }
          onClose();
        }}
      >
        <DialogPrimitive.Portal
          container={portalHost}
          keepMounted
          className="project-inspector-portal"
        >
          {mobileOpen ? <DialogPrimitive.Backdrop className="project-inspector-backdrop" /> : null}
          {/* Keep one portal in a stable panel host across breakpoints and closing.
          Changing its container would disconnect the terminal's live session. */}
          <DialogPrimitive.Popup
            className={cn("project-inspector", { "project-inspector-open": open })}
            id="project-inspector"
            inert={!open}
            ref={inspectorRef}
            role={mobileOpen ? "dialog" : "complementary"}
            initialFocus={() =>
              mobileOpen
                ? (inspectorRef.current?.querySelector<HTMLElement>(
                    '[role="tab"][aria-selected="true"]',
                  ) ?? true)
                : false
            }
            finalFocus={toggleRef}
          >
            <header className="project-inspector-header">
              <DialogPrimitive.Title id="project-inspector-title">
                Project inspector
              </DialogPrimitive.Title>
              {mobileOpen ? (
                <DialogPrimitive.Close aria-label="Close project inspector" className="icon-button">
                  ×
                </DialogPrimitive.Close>
              ) : null}
            </header>
            <Tabs
              className="inspector-tab-root gap-0"
              value={view}
              onValueChange={(value) => onViewChange(value as InspectorView)}
            >
              <TabsList
                activateOnFocus
                aria-label="Project inspector views"
                className="inspector-tabs w-full group-data-[orientation=horizontal]/tabs:h-[52px]"
                variant="line"
              >
                <TabsTrigger className="inspector-tab" value="overview">
                  Overview
                </TabsTrigger>
                <TabsTrigger className="inspector-tab" value="files">
                  Files
                </TabsTrigger>
                <TabsTrigger
                  className="inspector-tab"
                  value="changes"
                  disabled={!changesEnabled}
                  aria-label={changesEnabled ? "Changes" : "Changes unavailable"}
                >
                  Changes
                </TabsTrigger>
                <TabsTrigger
                  className="inspector-tab"
                  value="terminal"
                  disabled={!terminalEnabled}
                  aria-label={terminalEnabled ? "Terminal" : "Terminal unavailable"}
                >
                  Terminal
                </TabsTrigger>
                <TabsTrigger
                  className="inspector-tab"
                  value="preview"
                  disabled={!previewEnabled}
                  aria-label={previewEnabled ? "Preview" : "Preview unavailable"}
                >
                  Preview
                </TabsTrigger>
              </TabsList>
              <TabsContent value="overview">
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
                  <p className="inspector-empty">
                    Workspace files are temporary. Save a copy before stopping; idle expiry or
                    sandbox failure can also remove them. Conversation history remains available.
                  </p>
                  {!canStop && lease && lease.status !== "stopped" && !isStopping ? (
                    <p role="status" className="inspector-empty">
                      {hasActiveRun
                        ? "Finish or cancel the active Run before stopping."
                        : terminalActive
                          ? "Close Terminal before stopping."
                          : "Stop Preview before stopping the sandbox."}
                    </p>
                  ) : null}
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
              </TabsContent>
              <TabsContent value="files">
                <ProjectFiles
                  hasActiveRun={hasActiveRun || terminalActive}
                  key={`${project.id}:${filesRevision}`}
                  projectId={project.id}
                  sandboxAvailable={lease !== null && isActiveSandboxLease(lease.status)}
                />
              </TabsContent>
              <TabsContent value="changes">
                <ProjectChanges
                  projectBusy={hasActiveRun || terminalActive}
                  projectId={project.id}
                  sandboxAvailable={lease !== null && isActiveSandboxLease(lease.status)}
                />
              </TabsContent>
              {terminalEnabled ? (
                <TabsContent value="terminal" keepMounted>
                  <ProjectTerminal
                    active={view === "terminal"}
                    hasActiveRun={hasActiveRun || previewStarting}
                    onActivityChange={onTerminalActivityChange}
                    projectId={project.id}
                  />
                </TabsContent>
              ) : null}
              {previewEnabled ? (
                <TabsContent value="preview" keepMounted>
                  <ProjectPreview
                    active={view === "preview"}
                    onActivityChange={onPreviewActivityChange}
                    onStartingChange={onPreviewStartingChange}
                    projectBusy={hasActiveRun || terminalActive}
                    projectId={project.id}
                    sandboxAvailable={lease !== null && isActiveSandboxLease(lease.status)}
                  />
                </TabsContent>
              ) : null}
            </Tabs>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
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
        <Definition label="Default agent" value={runtimeLabel(project.defaultAgentRuntimeId)} />
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
          <Definition label="Model requests" value={String(run.usage.modelRequestCount)} />
          <Definition label="Tokens" value={formatTokenCount(run.usage.totalTokens)} />
          <Definition label="Duration" value={formatRunDuration(run)} />
        </dl>
      ) : (
        <p className="inspector-empty">No run selected.</p>
      )}
    </section>
  );
}

function Definition({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
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
