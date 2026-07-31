import {
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Folder,
  GitBranch,
  LoaderCircle,
  Paperclip,
  Play,
  Square,
  Terminal,
  TerminalSquare,
  XCircle,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { isTerminalAgentRun, type AgentRunStatus } from "../../domain/agent-run";
import type { AgentRunResponse, MessageResponse } from "../../shared/api";
import type { AgentRuntimeId } from "../../shared/protocol";
import type { BrowserApiError } from "../api";
import {
  agentRuntimeLabel,
  agentRunFailureLabel,
  agentRunStatusLabel,
  agentRunStatusTone,
  formatDateTime,
  formatRunDuration,
  formatTime,
  formatTokenCount,
  shortRunId,
} from "../presentation";
import { AgentMessageMarkdown } from "./agent-message-markdown";
import { ErrorState, LoadingState } from "./ui-states";
import { handleRovingTabKeyDown } from "../tab-navigation";

export type ProjectConsoleView = "conversation" | "runs";

export function ProjectRunTabs({
  onViewChange,
  view,
}: {
  onViewChange: (view: ProjectConsoleView) => void;
  view: ProjectConsoleView;
}) {
  return (
    <div
      aria-label="Project views"
      className="project-run-tabs"
      onKeyDown={handleRovingTabKeyDown}
      role="tablist"
    >
      <button
        aria-selected={view === "conversation"}
        className={view === "conversation" ? "console-tab console-tab-active" : "console-tab"}
        onClick={() => onViewChange("conversation")}
        role="tab"
        tabIndex={view === "conversation" ? 0 : -1}
        type="button"
      >
        Conversation
      </button>
      <button
        aria-selected={view === "runs"}
        className={view === "runs" ? "console-tab console-tab-active" : "console-tab"}
        onClick={() => onViewChange("runs")}
        role="tab"
        tabIndex={view === "runs" ? 0 : -1}
        type="button"
      >
        Runs
      </button>
    </div>
  );
}

export function RunStatusBar({
  cancelError,
  isCancelling,
  loadError,
  onCancel,
  run,
  streamError,
}: {
  cancelError: Error | null;
  isCancelling: boolean;
  loadError: Error | null;
  onCancel: () => void;
  run: AgentRunResponse | undefined;
  streamError: BrowserApiError | null;
}) {
  if (loadError) {
    return <ErrorState compact error={loadError} />;
  }

  if (!run) {
    return null;
  }

  const terminal = isTerminalAgentRun(run.status);
  if (terminal) {
    return null;
  }

  return (
    <section aria-label="Current run status" aria-live="polite" className="run-status-bar">
      <div className={`run-status-pill ${agentRunStatusTone(run.status)}`}>
        <RunStatusIcon status={run.status} />
        <span>{agentRunStatusLabel(run.status)}</span>
      </div>
      <span className="run-status-separator" aria-hidden="true" />
      <span>Run {shortRunId(run.id)}</span>
      <span>{formatRunDuration(run)}</span>
      <div className="run-status-spacer" />
      {run.failureCode ? (
        <p className="run-status-error">{agentRunFailureLabel(run.failureCode)}</p>
      ) : null}
      {streamError ? <p className="run-status-note">{streamError.message}</p> : null}
      {cancelError ? <ErrorState compact error={cancelError} /> : null}
      {!terminal ? (
        <button
          aria-label="Cancel run"
          className="icon-button icon-button-danger"
          disabled={isCancelling}
          onClick={onCancel}
          title="Cancel run"
          type="button"
        >
          {isCancelling ? (
            <LoaderCircle aria-hidden="true" className="spin" size={16} />
          ) : (
            <Square aria-hidden="true" size={14} />
          )}
        </button>
      ) : null}
    </section>
  );
}

export function RunMetrics({
  compact = false,
  run,
}: {
  compact?: boolean;
  run: AgentRunResponse | undefined;
}) {
  if (!run) {
    return null;
  }

  const metrics = [
    { label: "Input tokens", value: formatTokenCount(run.usage.inputTokens) },
    { label: "Output tokens", value: formatTokenCount(run.usage.outputTokens) },
    { label: "Total tokens", value: formatTokenCount(run.usage.totalTokens) },
    { label: "Model requests", value: String(run.usage.modelRequestCount) },
    { label: "Time", value: formatRunDuration(run) },
  ];

  return (
    <section aria-label="Selected run summary" className="run-summary">
      <header className="run-summary-header">
        <div className={`run-status-pill ${agentRunStatusTone(run.status)}`}>
          <RunStatusIcon status={run.status} />
          <span>{agentRunStatusLabel(run.status)}</span>
        </div>
        <span>Run {shortRunId(run.id)}</span>
        <time dateTime={run.createdAt}>{formatDateTime(run.createdAt)}</time>
        <span>{agentRuntimeLabel(run.agentRuntimeId)}</span>
      </header>
      {run.failureCode ? (
        <p className="run-summary-error">{agentRunFailureLabel(run.failureCode)}</p>
      ) : null}
      <dl
        aria-label="Selected run metrics"
        className={compact ? "run-metrics run-metrics-compact" : "run-metrics"}
      >
        {metrics.map((metric) => (
          <div key={metric.label}>
            <dt>{metric.label}</dt>
            <dd>{metric.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ConversationTimeline({
  error,
  isPending,
  messages,
  onRetry,
}: {
  error: Error | null;
  isPending: boolean;
  messages: MessageResponse[] | undefined;
  onRetry: () => void;
}) {
  if (isPending) {
    return <LoadingState label="Loading conversation" />;
  }

  if (error) {
    return <ErrorState error={error} onRetry={onRetry} />;
  }

  const visibleMessages = messages ?? [];

  if (visibleMessages.length === 0) {
    return (
      <div className="conversation-empty">
        <TerminalSquare aria-hidden="true" size={24} strokeWidth={1.5} />
        <p>No messages in this project.</p>
      </div>
    );
  }

  return (
    <ol className="conversation-timeline" aria-label="Project conversation">
      {visibleMessages.map((message) => (
        <li className={`timeline-message timeline-message-${message.role}`} key={message.id}>
          <article>
            <header>
              <span className="timeline-avatar" aria-hidden="true">
                {message.role === "user" ? "YOU" : <TerminalSquare size={15} />}
              </span>
              <strong>{message.role === "user" ? "You" : "Agent"}</strong>
              <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
            </header>
            {message.role === "assistant" ? (
              <AgentMessageMarkdown content={message.content} />
            ) : (
              <p className="timeline-message-copy">{message.content}</p>
            )}
          </article>
        </li>
      ))}
    </ol>
  );
}

export function RunHistory({
  error,
  isPending,
  messages,
  onRetry,
  onSelect,
  runs,
  selectedRunId,
}: {
  error: Error | null;
  isPending: boolean;
  messages: MessageResponse[] | undefined;
  onRetry: () => void;
  onSelect: (runId: string) => void;
  runs: AgentRunResponse[] | undefined;
  selectedRunId: string | null;
}) {
  return (
    <section aria-labelledby="run-history-title" className="run-history-panel">
      <div className="run-history-title">
        <h2 id="run-history-title">Run history</h2>
      </div>
      {isPending ? <LoadingState label="Loading runs" /> : null}
      {error ? <ErrorState compact error={error} onRetry={onRetry} /> : null}
      {!isPending && !error && runs?.length === 0 ? (
        <p className="run-history-empty">No runs yet.</p>
      ) : null}
      {runs && runs.length > 0 ? (
        <ol className="run-history-table">
          {runs.slice(0, 12).map((run) => {
            const inputMessage = messages?.find((message) => message.id === run.inputMessageId);
            const selected = run.id === selectedRunId;

            return (
              <li key={run.id}>
                <button
                  aria-pressed={selected}
                  className={
                    selected ? "run-history-entry run-history-entry-selected" : "run-history-entry"
                  }
                  onClick={() => onSelect(run.id)}
                  type="button"
                >
                  <span>{shortRunId(run.id)}</span>
                  <RunStatusIcon status={run.status} />
                  <strong title={inputMessage?.content}>
                    {inputMessage?.content ?? "Agent run"}
                  </strong>
                  <time dateTime={run.createdAt}>{formatDateTime(run.createdAt)}</time>
                  <span>{formatRunDuration(run)}</span>
                  <span>{formatTokenCount(run.usage.totalTokens)} tokens</span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

export function AgentComposer({
  agentRuntimeIds,
  changesEnabled,
  disabled,
  error,
  fileUploadDisabled,
  isSubmitting,
  isUploadingFile,
  onAgentRuntimeChange,
  onChangesOpen,
  onFilesOpen,
  onSubmit,
  onTerminalOpen,
  onUploadFile,
  selectedAgentRuntimeId,
  terminalEnabled,
  uploadError,
}: {
  agentRuntimeIds: readonly AgentRuntimeId[];
  changesEnabled: boolean;
  disabled: boolean;
  error: Error | null;
  fileUploadDisabled: boolean;
  isSubmitting: boolean;
  isUploadingFile: boolean;
  onAgentRuntimeChange: (agentRuntimeId: AgentRuntimeId) => void;
  onChangesOpen: () => void;
  onFilesOpen: () => void;
  onSubmit: (content: string, agentRuntimeId: AgentRuntimeId) => Promise<unknown>;
  onTerminalOpen: () => void;
  onUploadFile: (file: File) => Promise<unknown>;
  selectedAgentRuntimeId: AgentRuntimeId | null;
  terminalEnabled: boolean;
  uploadError: Error | null;
}) {
  const [content, setContent] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = content.trim();

    if (!trimmed) {
      setValidationError("Enter a task for the agent.");
      return;
    }
    if (!selectedAgentRuntimeId) {
      setValidationError("Select an available Agent.");
      return;
    }

    setValidationError(null);
    void submitRun(trimmed, selectedAgentRuntimeId);
  }

  async function submitRun(contentToSubmit: string, agentRuntimeId: AgentRuntimeId) {
    try {
      await onSubmit(contentToSubmit, agentRuntimeId);
      setContent("");
    } catch {
      // React Query exposes the request failure below the editor.
    }
  }

  return (
    <form className="agent-composer" onSubmit={submit}>
      <textarea
        aria-label="Agent task"
        disabled={disabled}
        id="agent-task"
        maxLength={64_000}
        name="content"
        onChange={(event) => setContent(event.target.value)}
        placeholder="Ask the agent to work on this project..."
        rows={3}
        value={content}
      />
      {validationError ? <p className="field-error">{validationError}</p> : null}
      {error ? <ErrorState compact error={error} /> : null}
      {uploadError ? <ErrorState compact error={uploadError} /> : null}
      <div className="agent-composer-toolbar">
        <div className="agent-composer-tools">
          <input
            aria-label="Choose file to upload"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) {
                void onUploadFile(file).catch(() => undefined);
              }
            }}
            ref={fileInputRef}
            type="file"
          />
          <ComposerTool
            disabled={fileUploadDisabled || isUploadingFile}
            icon={
              isUploadingFile ? (
                <LoaderCircle aria-hidden="true" className="spin" size={17} />
              ) : (
                <Paperclip aria-hidden="true" size={17} />
              )
            }
            label="Upload file"
            onClick={() => fileInputRef.current?.click()}
            title={
              fileUploadDisabled
                ? "Upload requires an idle Project sandbox"
                : "Upload file to workspace"
            }
          />
          <ComposerTool
            icon={<Folder aria-hidden="true" size={17} />}
            label="Open files"
            onClick={onFilesOpen}
          />
          <ComposerTool
            disabled={!terminalEnabled}
            icon={<Terminal aria-hidden="true" size={17} />}
            label="Open terminal"
            onClick={onTerminalOpen}
            title={terminalEnabled ? "Open terminal" : "Terminal unavailable"}
          />
          <ComposerTool
            disabled={!changesEnabled}
            icon={<GitBranch aria-hidden="true" size={17} />}
            label="Open changes"
            onClick={onChangesOpen}
            title={changesEnabled ? "Open changes" : "Changes unavailable"}
          />
        </div>
        <div className="agent-composer-actions">
          <AgentRuntimeSelector
            disabled={disabled}
            onChange={onAgentRuntimeChange}
            runtimeIds={agentRuntimeIds}
            selectedRuntimeId={selectedAgentRuntimeId}
          />
          <button
            aria-label="Start run"
            className="composer-submit"
            disabled={disabled || !content.trim()}
            title="Start run"
            type="submit"
          >
            {isSubmitting ? (
              <LoaderCircle aria-hidden="true" className="spin" size={17} />
            ) : (
              <Play aria-hidden="true" fill="currentColor" size={16} />
            )}
          </button>
        </div>
      </div>
    </form>
  );
}

function AgentRuntimeSelector({
  disabled,
  onChange,
  runtimeIds,
  selectedRuntimeId,
}: {
  disabled: boolean;
  onChange: (runtimeId: AgentRuntimeId) => void;
  runtimeIds: readonly AgentRuntimeId[];
  selectedRuntimeId: AgentRuntimeId | null;
}) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const selectorDisabled = disabled || runtimeIds.length < 2;
  const selectedIndex = selectedRuntimeId ? runtimeIds.indexOf(selectedRuntimeId) : 0;
  const selectedLabel = selectedRuntimeId ? agentRuntimeLabel(selectedRuntimeId) : "Unavailable";

  useEffect(() => {
    if (!open) {
      return;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      optionRefs.current[Math.max(selectedIndex, 0)]?.focus();
    });
    const closeOnPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, selectedIndex]);

  function focusOption(index: number) {
    optionRefs.current[index]?.focus();
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (selectorDisabled || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) {
      return;
    }

    event.preventDefault();
    setOpen(true);
  }

  function handleOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOption((index + 1) % runtimeIds.length);
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusOption((index - 1 + runtimeIds.length) % runtimeIds.length);
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusOption(0);
    }
    if (event.key === "End") {
      event.preventDefault();
      focusOption(runtimeIds.length - 1);
    }
  }

  return (
    <div className="agent-runtime-control" ref={rootRef}>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Agent runtime"
        className="agent-runtime-trigger"
        disabled={selectorDisabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
        ref={triggerRef}
        title="Choose Agent runtime"
        type="button"
      >
        <span>{selectedLabel}</span>
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      {open ? (
        <div
          aria-label="Agent runtime options"
          className="agent-runtime-menu"
          id={menuId}
          role="menu"
        >
          {runtimeIds.map((runtimeId, index) => {
            const selected = runtimeId === selectedRuntimeId;

            return (
              <button
                aria-checked={selected}
                className={
                  selected
                    ? "agent-runtime-option agent-runtime-option-selected"
                    : "agent-runtime-option"
                }
                key={runtimeId}
                onClick={() => {
                  onChange(runtimeId);
                  setOpen(false);
                  window.requestAnimationFrame(() => triggerRef.current?.focus());
                }}
                onKeyDown={(event) => handleOptionKeyDown(event, index)}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                role="menuitemradio"
                type="button"
              >
                <span>{agentRuntimeLabel(runtimeId)}</span>
                {selected ? <CheckCircle2 aria-hidden="true" size={14} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ComposerTool({
  disabled = false,
  icon,
  label,
  onClick,
  title = label,
}: {
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      aria-label={label}
      className="composer-tool"
      disabled={disabled}
      onClick={onClick}
      title={title}
      type="button"
    >
      {icon}
    </button>
  );
}

function RunStatusIcon({ status }: { status: AgentRunStatus }) {
  if (status === "succeeded") {
    return <CheckCircle2 aria-hidden="true" className="status-icon-success" size={16} />;
  }

  if (
    status === "failed" ||
    status === "cancelled" ||
    status === "timed_out" ||
    status === "interrupted"
  ) {
    return <XCircle aria-hidden="true" className="status-icon-error" size={16} />;
  }

  return <CircleDashed aria-hidden="true" className="status-icon-pending spin" size={16} />;
}
