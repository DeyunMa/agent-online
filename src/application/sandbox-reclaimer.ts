import type { DiagnosticReporter } from "../observability/contract";
import { isTerminalAgentRun } from "../domain/agent-run";
import type { RuntimeKind, SandboxRuntime } from "../runtime/contract";
import type { AgentRunRepository, SandboxLeaseRecord, SandboxLeaseRepository } from "./ports";
import type { Clock } from "./run-coordinator";

export type ActivityIdleCleanupInput = {
  expectedLeaseUpdatedAt: string;
  projectId: string;
};

export type RunIdleCleanupInput = {
  projectId: string;
  runId: string;
};

export type IdleSandboxStopResult = {
  detached: boolean;
  stopped: boolean;
};

export type ManualSandboxStopResult =
  | { kind: "conflict" }
  | { kind: "provider_error"; lease: SandboxLeaseRecord }
  | { kind: "stopped"; lease: SandboxLeaseRecord };

export type SandboxReclaimerDependencies = {
  agentRuns: Pick<AgentRunRepository, "findActiveByProjectId" | "findById">;
  clock: Clock;
  diagnostics?: DiagnosticReporter;
  getSandboxRuntime(id: RuntimeKind): SandboxRuntime;
  sandboxLeases: Pick<
    SandboxLeaseRepository,
    "claimForManualStop" | "claimIdleAfterActivityForStop" | "claimIdleForStop" | "findByProjectId"
  >;
};

/**
 * Owns atomic Lease detachment followed by best-effort provider cleanup.
 * Callers choose the eligibility rule; this module keeps provider references
 * private and applies one consistent detach-before-stop order.
 */
export class SandboxReclaimer {
  constructor(private readonly dependencies: SandboxReclaimerDependencies) {}

  async stopAfterRunIdle(input: RunIdleCleanupInput): Promise<IdleSandboxStopResult> {
    if (!input.projectId || !input.runId) {
      throw new Error("AgentRun execution identifiers are required");
    }

    const run = await this.dependencies.agentRuns.findById(input.runId);
    if (!run || run.projectId !== input.projectId) {
      return notStopped();
    }
    if (!isTerminalAgentRun(run.status)) {
      return notStopped();
    }
    if (await this.dependencies.agentRuns.findActiveByProjectId(run.projectId)) {
      return notStopped();
    }

    const lease = await this.dependencies.sandboxLeases.findByProjectId(run.projectId);
    if (
      !lease ||
      lease.id !== run.sandboxLeaseId ||
      lease.status !== "idle" ||
      !lease.providerRef
    ) {
      return notStopped();
    }

    const runtime = this.dependencies.getSandboxRuntime(lease.runtimeId);
    const providerRef = lease.providerRef;
    const claimed = await this.dependencies.sandboxLeases.claimIdleForStop({
      expectedProviderRef: providerRef,
      expectedRunId: run.id,
      expectedUpdatedAt: lease.updatedAt,
      leaseId: lease.id,
      updatedAt: this.timestamp(),
    });
    if (!claimed) {
      return notStopped();
    }

    const stopped = await this.stopProvider(runtime, lease, providerRef, "idle");
    this.dependencies.diagnostics?.report({
      detached: true,
      ...(stopped ? {} : { errorCode: "SANDBOX_PROCESS_FAILED" as const }),
      event: stopped ? "sandbox.idle_cleanup_finished" : "sandbox.idle_cleanup_failed",
      outcome: stopped ? "succeeded" : "failed",
      runId: run.id,
      stage: "idle_cleanup",
      stopped,
    });
    return { detached: true, stopped };
  }

  async stopAfterActivityIdle(input: ActivityIdleCleanupInput): Promise<IdleSandboxStopResult> {
    if (await this.dependencies.agentRuns.findActiveByProjectId(input.projectId)) {
      return notStopped();
    }

    const lease = await this.dependencies.sandboxLeases.findByProjectId(input.projectId);
    if (
      !lease?.providerRef ||
      lease.status !== "idle" ||
      lease.updatedAt !== input.expectedLeaseUpdatedAt
    ) {
      return notStopped();
    }

    const runtime = this.dependencies.getSandboxRuntime(lease.runtimeId);
    const providerRef = lease.providerRef;
    const claimed = await this.dependencies.sandboxLeases.claimIdleAfterActivityForStop({
      expectedProviderRef: providerRef,
      expectedUpdatedAt: input.expectedLeaseUpdatedAt,
      leaseId: lease.id,
      updatedAt: this.timestamp(),
    });
    if (!claimed) {
      return notStopped();
    }

    return {
      detached: true,
      stopped: await this.stopProvider(runtime, lease, providerRef, "idle"),
    };
  }

  async stopManually(lease: SandboxLeaseRecord): Promise<ManualSandboxStopResult> {
    if (!lease.providerRef || lease.status === "stopped") {
      return { kind: "conflict" };
    }

    const providerRef = lease.providerRef;
    const updatedAt = this.timestamp();
    const claimed = await this.dependencies.sandboxLeases.claimForManualStop({
      expectedProviderRef: providerRef,
      expectedUpdatedAt: lease.updatedAt,
      leaseId: lease.id,
      updatedAt,
    });
    if (!claimed) {
      return { kind: "conflict" };
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
    } catch {
      return { kind: "provider_error", lease: stoppedLease };
    }
  }

  private async stopProvider(
    runtime: SandboxRuntime,
    lease: SandboxLeaseRecord,
    providerRef: string,
    reason: "idle",
  ) {
    try {
      await runtime.stop(toRuntimeHandle(lease, providerRef), reason);
      return true;
    } catch {
      // The Lease was atomically detached first. Provider timeout bounds any orphan.
      return false;
    }
  }

  private timestamp() {
    return this.dependencies.clock.now().toISOString();
  }
}

function notStopped(): IdleSandboxStopResult {
  return { detached: false, stopped: false };
}

function toRuntimeHandle(lease: SandboxLeaseRecord, providerRef: string) {
  return {
    id: providerRef,
    kind: lease.runtimeId,
    sandboxLeaseId: lease.id,
  };
}
