import type { RuntimeHandle, RuntimeKind, SandboxRuntime } from "../runtime/contract";
import type {
  AgentRunRepository,
  PreviewSessionRepository,
  SandboxLeaseRecord,
  SandboxLeaseRepository,
  TerminalSessionRepository,
} from "./ports";

export type StopProjectSandboxResult =
  | { kind: "already_stopped"; lease: SandboxLeaseRecord | null }
  | { kind: "conflict" }
  | { kind: "project_busy" }
  | { kind: "provider_error"; lease: SandboxLeaseRecord }
  | { kind: "stopped"; lease: SandboxLeaseRecord };

export type ProjectSandboxServiceDependencies = {
  agentRuns: AgentRunRepository;
  getSandboxRuntime(id: RuntimeKind): SandboxRuntime;
  now(): Date;
  previewSessions: Pick<PreviewSessionRepository, "findByProjectId">;
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
    const now = this.dependencies.now().toISOString();
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

    const providerRef = lease.providerRef;
    const updatedAt = now;
    const claimed = await this.dependencies.sandboxLeases.claimForManualStop({
      expectedProviderRef: providerRef,
      expectedUpdatedAt: lease.updatedAt,
      leaseId: lease.id,
      updatedAt,
    });
    if (!claimed) {
      return this.resolveClaimConflict(projectId);
    }

    const stoppedLease: SandboxLeaseRecord = {
      ...lease,
      providerRef: null,
      status: "stopped",
      updatedAt,
    };

    try {
      const runtime = this.dependencies.getSandboxRuntime(lease.runtimeId);
      await runtime.stop(toRuntimeHandle(lease, providerRef), "manual");
      return { kind: "stopped", lease: stoppedLease };
    } catch (_error) {
      // The provider reference stays detached. Provider-side timeout remains
      // the cleanup bound if the stop request itself fails.
      return { kind: "provider_error", lease: stoppedLease };
    }
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

function toRuntimeHandle(lease: SandboxLeaseRecord, providerRef: string): RuntimeHandle {
  return {
    id: providerRef,
    kind: lease.runtimeId,
    sandboxLeaseId: lease.id,
  };
}
