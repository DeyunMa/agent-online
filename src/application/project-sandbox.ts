import type {
  AgentRunRepository,
  PreviewSessionRepository,
  SandboxLeaseRecord,
  SandboxLeaseRepository,
  TerminalSessionRepository,
} from "./ports";
import type { SandboxReclaimer } from "./sandbox-reclaimer";

export type StopProjectSandboxResult =
  | { kind: "already_stopped"; lease: SandboxLeaseRecord | null }
  | { kind: "conflict" }
  | { kind: "project_busy" }
  | { kind: "provider_error"; lease: SandboxLeaseRecord }
  | { kind: "stopped"; lease: SandboxLeaseRecord };

export type ProjectSandboxServiceDependencies = {
  agentRuns: AgentRunRepository;
  previewSessions: Pick<PreviewSessionRepository, "findByProjectId">;
  sandboxReclaimer: Pick<SandboxReclaimer, "stopManually">;
  sandboxLeases: SandboxLeaseRepository;
  terminalSessions: Pick<TerminalSessionRepository, "findByProjectId">;
};

/**
 * Owns user-requested Project sandbox lifecycle operations without exposing
 * provider-private identifiers to HTTP handlers or browser contracts.
 */
export class ProjectSandboxService {
  constructor(private readonly dependencies: ProjectSandboxServiceDependencies) {}

  async stop(projectId: string): Promise<StopProjectSandboxResult> {
    const lease = await this.dependencies.sandboxLeases.findByProjectId(projectId);
    const activeRun = await this.dependencies.agentRuns.findActiveByProjectId(projectId);
    if (activeRun) {
      return { kind: "project_busy" };
    }
    if (await this.dependencies.terminalSessions.findByProjectId(projectId)) {
      return { kind: "project_busy" };
    }
    if (await this.dependencies.previewSessions.findByProjectId(projectId)) {
      return { kind: "project_busy" };
    }
    if (!lease?.providerRef || lease.status === "stopped") {
      return { kind: "already_stopped", lease };
    }

    const stopped = await this.dependencies.sandboxReclaimer.stopManually(lease);
    if (stopped.kind === "conflict") {
      return this.resolveClaimConflict(projectId);
    }
    return stopped;
  }

  private async resolveClaimConflict(projectId: string): Promise<StopProjectSandboxResult> {
    const activeRun = await this.dependencies.agentRuns.findActiveByProjectId(projectId);
    if (activeRun) {
      return { kind: "project_busy" };
    }
    if (await this.dependencies.terminalSessions.findByProjectId(projectId)) {
      return { kind: "project_busy" };
    }
    if (await this.dependencies.previewSessions.findByProjectId(projectId)) {
      return { kind: "project_busy" };
    }

    const currentLease = await this.dependencies.sandboxLeases.findByProjectId(projectId);
    if (!currentLease?.providerRef || currentLease.status === "stopped") {
      return { kind: "already_stopped", lease: currentLease };
    }

    return { kind: "conflict" };
  }
}
