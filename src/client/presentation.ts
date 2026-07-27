import { isTerminalAgentRun, type AgentRunStatus } from "../domain/agent-run";
import type { AgentRunResponse, SandboxLeaseResponse } from "../shared/api";

export function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "numeric",
    month: "short",
  }).format(new Date(value));
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(new Date(value));
}

export function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function sandboxStatusLabel(status: SandboxLeaseResponse["status"]) {
  const labels: Record<SandboxLeaseResponse["status"], string> = {
    busy: "执行中",
    failed: "异常",
    idle: "空闲",
    ready: "就绪",
    starting: "启动中",
    stopped: "已停止",
  };

  return labels[status];
}

export function sandboxStatusTone(status: SandboxLeaseResponse["status"] | undefined) {
  if (status === "idle" || status === "ready") {
    return "tone-success";
  }

  if (status === "busy" || status === "starting") {
    return "tone-warning";
  }

  if (status === "failed") {
    return "tone-danger";
  }

  return "tone-neutral";
}

export function agentRunStatusLabel(status: AgentRunStatus) {
  const labels: Record<AgentRunStatus, string> = {
    cancelled: "已取消",
    cancelling: "正在取消",
    failed: "执行失败",
    interrupted: "执行中断",
    queued: "等待执行",
    running: "正在执行",
    starting: "正在启动",
    succeeded: "执行完成",
    timed_out: "执行超时",
  };

  return labels[status];
}

export function agentRunStatusTone(status: AgentRunStatus) {
  if (status === "succeeded") {
    return "tone-success";
  }

  if (
    status === "failed" ||
    status === "cancelled" ||
    status === "timed_out" ||
    status === "interrupted"
  ) {
    return "tone-danger";
  }

  return "tone-warning";
}

export function formatRunDuration(run: AgentRunResponse) {
  if (run.usage.sandboxDurationMs > 0) {
    return formatDuration(run.usage.sandboxDurationMs);
  }

  if (run.startedAt && run.finishedAt) {
    return formatDuration(
      Math.max(0, new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()),
    );
  }

  return isTerminalAgentRun(run.status) ? "—" : "进行中";
}

export function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
}

export function formatTokenCount(tokens: number) {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 1,
    notation: tokens >= 1_000 ? "compact" : "standard",
  }).format(tokens);
}

export function shortRunId(runId: string) {
  return runId.length <= 8 ? runId : runId.slice(0, 8);
}
