import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ChartNoAxesColumn,
  ExternalLink,
  RefreshCw,
} from "lucide-react";

import type {
  UsageMetricsResponse,
  UserUsageResponse,
} from "../../shared/api";
import { browserApi } from "../api";
import { formatDuration, formatTokenCount } from "../presentation";
import { userUsageQueryKey } from "../query-keys";
import { AppHeaderSlot } from "./app-header-slot";
import { ErrorState, LoadingState } from "./ui-states";

export function UsagePage() {
  const usage = useQuery({
    queryFn: browserApi.getUsage,
    queryKey: userUsageQueryKey,
    staleTime: 30_000,
  });

  return (
    <section className="usage-page">
      <AppHeaderSlot>
        <div className="app-header-page">
          <strong>Usage</strong>
        </div>
      </AppHeaderSlot>

      <div className="usage-page-content">
        <header className="usage-page-header">
          <div>
            <p className="eyebrow">ALL-TIME ACTIVITY</p>
            <h1>Usage</h1>
            <p>Recorded consumption across your Agent runs.</p>
          </div>
          <button
            aria-label="Refresh usage"
            className="icon-button usage-refresh"
            disabled={usage.isFetching}
            onClick={() => void usage.refetch()}
            title="Refresh usage"
            type="button"
          >
            <RefreshCw
              aria-hidden="true"
              className={usage.isFetching ? "spin" : undefined}
              size={17}
            />
          </button>
        </header>

        {usage.isPending ? <LoadingState label="Loading usage" /> : null}
        {usage.isError ? (
          <ErrorState
            error={usage.error}
            onRetry={() => void usage.refetch()}
          />
        ) : null}
        {usage.isSuccess && usage.data.totals.runCount === 0 ? (
          <UsageEmptyState />
        ) : null}
        {usage.isSuccess && usage.data.totals.runCount > 0 ? (
          <UsageReport report={usage.data} />
        ) : null}
      </div>
    </section>
  );
}

function UsageReport({ report }: { report: UserUsageResponse }) {
  const metrics = [
    {
      label: "Input tokens",
      value: formatTokenCount(report.totals.inputTokens),
    },
    {
      label: "Output tokens",
      value: formatTokenCount(report.totals.outputTokens),
    },
    {
      label: "Model requests",
      value: formatInteger(report.totals.modelRequestCount),
    },
    {
      label: "Sandbox time",
      value: formatDuration(report.totals.sandboxDurationMs),
    },
  ];

  return (
    <div className="usage-report">
      <section aria-labelledby="usage-summary-title" className="usage-summary">
        <div className="usage-summary-total">
          <span id="usage-summary-title">Total tokens</span>
          <strong>{formatTokenCount(report.totals.totalTokens)}</strong>
          <small>{formatRunCount(report.totals.runCount)}</small>
        </div>
        {metrics.map((metric) => (
          <div className="usage-summary-metric" key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
          </div>
        ))}
      </section>

      <UsageTableSection
        description="All recorded runs grouped by Project."
        rows={report.projects.map((project) => ({
          key: project.projectId,
          label: (
            <Link
              className="usage-project-link"
              params={{ projectId: project.projectId }}
              to="/projects/$projectId"
            >
              <span>{project.projectTitle}</span>
              <ExternalLink aria-hidden="true" size={13} />
            </Link>
          ),
          usage: project.usage,
        }))}
        title="Projects"
      />

      <UsageTableSection
        description="The Agent runtimes responsible for those runs."
        rows={report.agentRuntimes.map((runtime) => ({
          key: runtime.agentRuntimeId,
          label: agentRuntimeLabel(runtime.agentRuntimeId),
          usage: runtime.usage,
        }))}
        title="Agents"
      />
    </div>
  );
}

function UsageTableSection({
  description,
  rows,
  title,
}: {
  description: string;
  rows: Array<{
    key: string;
    label: React.ReactNode;
    usage: UsageMetricsResponse;
  }>;
  title: string;
}) {
  return (
    <section className="usage-breakdown">
      <header>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </header>
      <div className="usage-table-scroll">
        <table className="usage-table">
          <thead>
            <tr>
              <th scope="col">{title === "Projects" ? "Project" : "Agent"}</th>
              <th scope="col">Runs</th>
              <th scope="col">Input</th>
              <th scope="col">Output</th>
              <th scope="col">Total</th>
              <th scope="col">Requests</th>
              <th scope="col">Sandbox</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                <td>{formatInteger(row.usage.runCount)}</td>
                <td>{formatTokenCount(row.usage.inputTokens)}</td>
                <td>{formatTokenCount(row.usage.outputTokens)}</td>
                <td>{formatTokenCount(row.usage.totalTokens)}</td>
                <td>{formatInteger(row.usage.modelRequestCount)}</td>
                <td>{formatDuration(row.usage.sandboxDurationMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UsageEmptyState() {
  return (
    <div className="empty-state usage-empty-state">
      <ChartNoAxesColumn aria-hidden="true" size={27} strokeWidth={1.5} />
      <div>
        <p>No usage recorded yet.</p>
        <span>Usage appears after you start an Agent run.</span>
      </div>
      <Link className="secondary-action" to="/">
        View projects
      </Link>
    </div>
  );
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatRunCount(value: number) {
  return `${formatInteger(value)} ${value === 1 ? "run" : "runs"}`;
}

function agentRuntimeLabel(agentRuntimeId: string) {
  const labels: Record<string, string> = {
    "claude-code": "Claude Code",
    "codex-cli": "Codex CLI",
    goose: "Goose",
    pi: "Pi",
  };

  return labels[agentRuntimeId] ?? agentRuntimeId;
}
