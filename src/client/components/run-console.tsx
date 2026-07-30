import {
  CheckCircle2,
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
import { type FormEvent, type ReactNode, type RefObject, useState } from "react";

import { isTerminalAgentRun, type AgentRunStatus } from "../../domain/agent-run";
import type { AgentRunResponse, MessageResponse } from "../../shared/api";
import type { BrowserApiError } from "../api";
import {
  agentRunFailureLabel,
  agentRunStatusLabel,
  agentRunStatusTone,
  formatDateTime,
  formatRunDuration,
  formatTime,
  formatTokenCount,
  shortRunId,
} from "../presentation";
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
    return (
      <div className="run-status-bar run-status-bar-empty">
        <span>No run selected</span>
      </div>
    );
  }

  const terminal = isTerminalAgentRun(run.status);

  return (
    <section aria-label="Current run status" aria-live="polite" className="run-status-bar">
      <div className={`run-status-pill ${agentRunStatusTone(run.status)}`}>
        <RunStatusIcon status={run.status} />
        <span>{agentRunStatusLabel(run.status)}</span>
      </div>
      <span className="run-status-separator" aria-hidden="true" />
      <span>Run {shortRunId(run.id)}</span>
      <time dateTime={run.createdAt}>{formatDateTime(run.createdAt)}</time>
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

export function RunMetrics({ run }: { run: AgentRunResponse | undefined }) {
  const metrics = [
    { label: "Input tokens", value: run ? formatTokenCount(run.usage.inputTokens) : "—" },
    { label: "Output tokens", value: run ? formatTokenCount(run.usage.outputTokens) : "—" },
    { label: "Total tokens", value: run ? formatTokenCount(run.usage.totalTokens) : "—" },
    { label: "Model requests", value: run ? String(run.usage.modelRequestCount) : "—" },
    { label: "Time", value: run ? formatRunDuration(run) : "—" },
  ];

  return (
    <dl className="run-metrics">
      {metrics.map((metric) => (
        <div key={metric.label}>
          <dt>{metric.label}</dt>
          <dd>{metric.value}</dd>
        </div>
      ))}
    </dl>
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
          <span className="timeline-avatar" aria-hidden="true">
            {message.role === "user" ? "YOU" : <TerminalSquare size={17} />}
          </span>
          <article>
            <header>
              <strong>{message.role === "user" ? "You" : "Agent"}</strong>
              <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
            </header>
            <p>{message.content}</p>
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
  disabled,
  error,
  isSubmitting,
  onSubmit,
  textareaRef,
}: {
  disabled: boolean;
  error: Error | null;
  isSubmitting: boolean;
  onSubmit: (content: string) => Promise<unknown>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [content, setContent] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = content.trim();

    if (!trimmed) {
      setValidationError("Enter a task for the agent.");
      return;
    }

    setValidationError(null);
    void submitRun(trimmed);
  }

  async function submitRun(contentToSubmit: string) {
    try {
      await onSubmit(contentToSubmit);
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
        ref={textareaRef}
        rows={3}
        value={content}
      />
      {validationError ? <p className="field-error">{validationError}</p> : null}
      {error ? <ErrorState compact error={error} /> : null}
      <div className="agent-composer-toolbar">
        <div className="agent-composer-tools">
          <DisabledTool icon={<Paperclip size={17} />} label="Attachments unavailable" />
          <DisabledTool icon={<Folder size={17} />} label="Files unavailable" />
          <DisabledTool icon={<Terminal size={17} />} label="Terminal unavailable" />
          <DisabledTool icon={<GitBranch size={17} />} label="Changes unavailable" />
        </div>
        <div className="agent-composer-actions">
          <button className="agent-runtime-select" disabled type="button">
            Pi
          </button>
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

function DisabledTool({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <button aria-label={label} className="composer-tool" disabled title={label} type="button">
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
