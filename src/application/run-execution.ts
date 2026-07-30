import type { AgentRunInput, AgentRuntime, AgentRuntimeId } from "../agent/contract";
import { isTerminalAgentRun } from "../domain/agent-run";
import {
  type DiagnosticErrorCode,
  type DiagnosticReporter,
  type DiagnosticStage,
  noopDiagnosticReporter,
} from "../observability/contract";
import type { RuntimeHandle, RuntimeKind, SandboxRuntime } from "../runtime/contract";
import type { AgentRunFailureCode } from "../shared/error-codes";
import type {
  AgentRunRecord,
  AgentRunRepository,
  MessageRepository,
  SandboxLeaseRecord,
  SandboxLeaseRepository,
} from "./ports";
import { RunCoordinator, type Clock, type CoordinatedAgentRun } from "./run-coordinator";
import type {
  ActivityIdleCleanupInput,
  IdleSandboxStopResult,
  SandboxReclaimer,
} from "./sandbox-reclaimer";

export type { ActivityIdleCleanupInput, IdleSandboxStopResult } from "./sandbox-reclaimer";

type ModelAccess = NonNullable<AgentRunInput["modelAccess"]>;

export type AgentRunExecutionInput = {
  projectId: string;
  runId: string;
};

export type RunExecutionServiceDependencies = {
  agentRuns: AgentRunRepository;
  clock: Clock;
  createId(): string;
  diagnostics?: DiagnosticReporter;
  getAgentRuntime(id: AgentRuntimeId): AgentRuntime;
  getSandboxRuntime(id: RuntimeKind): SandboxRuntime;
  issueModelAccess(input: {
    expiresAt: Date;
    issuedAt: Date;
    run: AgentRunRecord;
  }): Promise<ModelAccess>;
  messages: MessageRepository;
  runTimeoutMs: number;
  sandboxReclaimer: Pick<SandboxReclaimer, "stopAfterActivityIdle" | "stopAfterRunIdle">;
  sandboxLeases: SandboxLeaseRepository;
  workingDirectory: string;
};

/**
 * Owns provider-independent execution recovery, cancellation, and idle cleanup.
 * Cloudflare Workflows supplies durable scheduling around these operations.
 */
export class RunExecutionService {
  constructor(private readonly dependencies: RunExecutionServiceDependencies) {
    if (!Number.isSafeInteger(dependencies.runTimeoutMs) || dependencies.runTimeoutMs < 1) {
      throw new Error("Run execution timeout must be a positive safe integer");
    }
  }

  async execute(input: AgentRunExecutionInput): Promise<AgentRunRecord> {
    const run = await this.requireRun(input);
    if (isTerminalAgentRun(run.status)) {
      return run;
    }

    this.report({
      agentRuntimeId: run.agentRuntimeId,
      event: "agent_run.execution_started",
      modelId: run.modelId,
      outcome: "started",
      runId: run.id,
      runStatus: run.status,
      sandboxRuntimeId: run.sandboxRuntimeId,
    });

    if (run.status !== "queued") {
      if (run.status !== "cancelling") {
        this.report({
          agentRuntimeId: run.agentRuntimeId,
          errorCode: "RUN_STATE_CONFLICT",
          event: "agent_run.stage_failed",
          failureCode: "run.interrupted",
          modelId: run.modelId,
          outcome: "failed",
          runId: run.id,
          runStatus: run.status,
          sandboxRuntimeId: run.sandboxRuntimeId,
          stage: "claim_run",
        });
      }
      const recovered = await this.recoverUnownedRun(run);
      this.reportFinished(recovered);
      return recovered;
    }

    let stage: DiagnosticStage = "load_input";
    try {
      const message = await this.dependencies.messages.findById(
        requireValue(run.inputMessageId, "AgentRun input message"),
        run.projectId,
      );
      if (message?.role !== "user") {
        throw new Error("AgentRun input message is unavailable");
      }

      stage = "load_lease";
      const sandboxLease = await this.dependencies.sandboxLeases.findByProjectId(run.projectId);
      assertSandboxLease(run, sandboxLease);

      stage = "issue_model_access";
      const issuedAt = this.dependencies.clock.now();
      const expiresAt = new Date(issuedAt.getTime() + this.dependencies.runTimeoutMs);
      const modelAccess = await this.dependencies.issueModelAccess({
        expiresAt,
        issuedAt,
        run,
      });
      const coordinator = new RunCoordinator({
        agentRunRepository: this.dependencies.agentRuns,
        clock: this.dependencies.clock,
        createId: this.dependencies.createId,
        ...(this.dependencies.diagnostics ? { diagnostics: this.dependencies.diagnostics } : {}),
        getAgentRuntime: this.dependencies.getAgentRuntime,
        getSandboxRuntime: this.dependencies.getSandboxRuntime,
        sandboxLeaseRepository: this.dependencies.sandboxLeases,
      });
      stage = "claim_run";
      const managedRun = await coordinator.start({
        agentRun: run,
        modelAccess,
        prompt: message.content,
        sandboxLease,
        workingDirectory: this.dependencies.workingDirectory,
      });

      stage = "consume_events";
      const completed = await completionWithTimeout(
        managedRun,
        Math.max(1, expiresAt.getTime() - this.dependencies.clock.now().getTime()),
      );
      this.reportFinished(completed);
      return completed;
    } catch {
      const failure = classifyExecutionFailure(stage);
      this.report({
        agentRuntimeId: run.agentRuntimeId,
        errorCode: failure.errorCode,
        event: "agent_run.stage_failed",
        failureCode: failure.failureCode,
        modelId: run.modelId,
        outcome: "failed",
        runId: run.id,
        sandboxRuntimeId: run.sandboxRuntimeId,
        stage,
      });
      const completed = await this.convergeExecutionFailure(run.id, failure.failureCode);
      this.reportFinished(completed);
      return completed;
    }
  }

  async cancel(input: AgentRunExecutionInput): Promise<AgentRunRecord> {
    const run = await this.cancelRun(input);
    this.reportFinished(run);
    return run;
  }

  private async cancelRun(input: AgentRunExecutionInput): Promise<AgentRunRecord> {
    let run = await this.requireRun(input);
    if (isTerminalAgentRun(run.status)) {
      return run;
    }

    if (run.status === "queued") {
      return this.transitionOrReload(run, "cancelled", {
        finishedAt: this.timestamp(),
      });
    }

    if (run.status === "starting" || run.status === "running") {
      run = await this.transitionOrReload(run, "cancelling");
      if (isTerminalAgentRun(run.status)) {
        return run;
      }
    }

    const sandboxLease = await this.dependencies.sandboxLeases.findByProjectId(run.projectId);
    if (sandboxLease?.id === run.sandboxLeaseId) {
      await this.releaseRunProcess(run, sandboxLease, "cancelled");
    }

    run = (await this.dependencies.agentRuns.findById(run.id)) ?? run;
    if (isTerminalAgentRun(run.status)) {
      return run;
    }

    const finishedAt = this.timestamp();
    run = await this.recordSandboxDuration(run, finishedAt);
    if (isTerminalAgentRun(run.status)) {
      return run;
    }

    return this.transitionOrReload(run, "cancelled", {
      failureCode: null,
      finishedAt,
    });
  }

  async stopSandboxIfIdle(input: AgentRunExecutionInput): Promise<IdleSandboxStopResult> {
    return this.dependencies.sandboxReclaimer.stopAfterRunIdle(input);
  }

  async stopSandboxAfterActivityIdle(
    input: ActivityIdleCleanupInput,
  ): Promise<IdleSandboxStopResult> {
    return this.dependencies.sandboxReclaimer.stopAfterActivityIdle(input);
  }

  private async convergeExecutionFailure(
    runId: string,
    failureCode: AgentRunFailureCode,
  ): Promise<AgentRunRecord> {
    const current = await this.dependencies.agentRuns.findById(runId);
    if (!current) {
      throw new Error(`AgentRun not found: ${runId}`);
    }
    if (isTerminalAgentRun(current.status)) {
      return current;
    }
    if (current.status === "queued") {
      return this.transitionOrReload(current, "failed", {
        failureCode,
        finishedAt: this.timestamp(),
      });
    }

    return this.recoverUnownedRun(current);
  }

  private async recoverUnownedRun(run: AgentRunRecord): Promise<AgentRunRecord> {
    const targetStatus = run.status === "cancelling" ? "cancelled" : "interrupted";
    const sandboxLease = await this.dependencies.sandboxLeases.findByProjectId(run.projectId);
    if (sandboxLease?.id === run.sandboxLeaseId) {
      await this.releaseRunProcess(
        run,
        sandboxLease,
        targetStatus === "cancelled" ? "cancelled" : "failed",
      );
    }

    let current = (await this.dependencies.agentRuns.findById(run.id)) ?? run;
    if (isTerminalAgentRun(current.status)) {
      return current;
    }

    const finishedAt = this.timestamp();
    current = await this.recordSandboxDuration(current, finishedAt);
    if (isTerminalAgentRun(current.status)) {
      return current;
    }

    return this.transitionOrReload(current, targetStatus, {
      failureCode: targetStatus === "interrupted" ? "run.interrupted" : null,
      finishedAt,
    });
  }

  private async releaseRunProcess(
    run: AgentRunRecord,
    sandboxLease: SandboxLeaseRecord,
    reason: "cancelled" | "failed",
  ) {
    if (!sandboxLease.providerRef) {
      await this.updateLeaseBestEffort(sandboxLease, null, "stopped");
      return;
    }

    let runtime: SandboxRuntime;
    try {
      runtime = this.dependencies.getSandboxRuntime(sandboxLease.runtimeId);
    } catch (_error) {
      await this.updateLeaseBestEffort(sandboxLease, sandboxLease.providerRef, "failed");
      return;
    }

    const handle = toRuntimeHandle(sandboxLease, sandboxLease.providerRef);
    if (run.providerProcessRef) {
      try {
        await runtime.terminateProcess(handle, run.providerProcessRef, reason);
        await this.updateLeaseBestEffort(sandboxLease, sandboxLease.providerRef, "idle");
        return;
      } catch (_error) {
        // Fall through to whole-sandbox termination when the process cannot be targeted.
      }
    }

    try {
      await runtime.stop(handle, "failed");
      await this.updateLeaseBestEffort(sandboxLease, null, "stopped");
    } catch (_error) {
      await this.updateLeaseBestEffort(sandboxLease, sandboxLease.providerRef, "failed");
    }
  }

  private async recordSandboxDuration(run: AgentRunRecord, finishedAt: string) {
    if (run.sandboxRuntimeId === "fake" || !run.startedAt) {
      return run;
    }

    const sandboxDurationMs = Math.max(
      0,
      new Date(finishedAt).getTime() - new Date(run.startedAt).getTime(),
    );
    const updated = await this.dependencies.agentRuns.setSandboxDuration(run.id, sandboxDurationMs);
    return updated ?? (await this.dependencies.agentRuns.findById(run.id)) ?? run;
  }

  private async requireRun(input: AgentRunExecutionInput): Promise<AgentRunRecord> {
    if (!input.projectId || !input.runId) {
      throw new Error("AgentRun execution identifiers are required");
    }

    const run = await this.dependencies.agentRuns.findById(input.runId);
    if (!run || run.projectId !== input.projectId) {
      throw new Error(`AgentRun not found: ${input.runId}`);
    }

    return run;
  }

  private async transitionOrReload(
    run: AgentRunRecord,
    to: AgentRunRecord["status"],
    values: {
      failureCode?: AgentRunFailureCode | null;
      finishedAt?: string | null;
    } = {},
  ) {
    const updated = await this.dependencies.agentRuns.transition({
      ...values,
      from: run.status,
      runId: run.id,
      to,
    });
    if (updated) {
      return updated;
    }

    const current = await this.dependencies.agentRuns.findById(run.id);
    if (current && isTerminalAgentRun(current.status)) {
      return current;
    }

    throw new Error(`Unable to transition AgentRun from ${run.status} to ${to}`);
  }

  private async updateLeaseBestEffort(
    sandboxLease: SandboxLeaseRecord,
    providerRef: string | null,
    status: SandboxLeaseRecord["status"],
  ) {
    try {
      await this.dependencies.sandboxLeases.updateState({
        leaseId: sandboxLease.id,
        providerRef,
        status,
        updatedAt: this.timestamp(),
      });
    } catch (_error) {
      // Run state must still converge if a provider or Lease update fails.
    }
  }

  private timestamp() {
    return this.dependencies.clock.now().toISOString();
  }

  private report(event: Parameters<DiagnosticReporter["report"]>[0]) {
    (this.dependencies.diagnostics ?? noopDiagnosticReporter).report(event);
  }

  private reportFinished(run: AgentRunRecord) {
    this.report({
      agentRuntimeId: run.agentRuntimeId,
      event: "agent_run.execution_finished",
      ...(run.failureCode ? { failureCode: run.failureCode } : {}),
      inputTokens: run.usage.inputTokens,
      modelId: run.modelId,
      modelRequestCount: run.usage.modelRequestCount,
      outcome:
        run.status === "succeeded"
          ? "succeeded"
          : run.status === "cancelled"
            ? "rejected"
            : "failed",
      outputTokens: run.usage.outputTokens,
      runId: run.id,
      runStatus: run.status,
      sandboxDurationMs: run.usage.sandboxDurationMs,
      sandboxRuntimeId: run.sandboxRuntimeId,
      totalTokens: run.usage.totalTokens,
    });
  }
}

async function completionWithTimeout(managedRun: CoordinatedAgentRun, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<AgentRunRecord>((resolve, reject) => {
    timer = setTimeout(() => {
      void managedRun.cancel("timed_out").then(resolve, reject);
    }, timeoutMs);
  });

  try {
    return await Promise.race([managedRun.completion, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function assertSandboxLease(
  run: AgentRunRecord,
  sandboxLease: SandboxLeaseRecord | null,
): asserts sandboxLease is SandboxLeaseRecord {
  if (
    !sandboxLease ||
    sandboxLease.id !== run.sandboxLeaseId ||
    sandboxLease.projectId !== run.projectId ||
    sandboxLease.runtimeId !== run.sandboxRuntimeId
  ) {
    throw new Error("AgentRun SandboxLease is unavailable or inconsistent");
  }
}

function toRuntimeHandle(sandboxLease: SandboxLeaseRecord, providerRef: string): RuntimeHandle {
  return {
    id: providerRef,
    kind: sandboxLease.runtimeId,
    sandboxLeaseId: sandboxLease.id,
  };
}

function requireValue(value: string | null, name: string) {
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function classifyExecutionFailure(stage: DiagnosticStage): {
  errorCode: DiagnosticErrorCode;
  failureCode: AgentRunFailureCode;
} {
  switch (stage) {
    case "load_input":
      return {
        errorCode: "RUN_INPUT_UNAVAILABLE",
        failureCode: "run.internal_failed",
      };
    case "load_lease":
      return {
        errorCode: "LEASE_INCONSISTENT",
        failureCode: "run.sandbox_failed",
      };
    case "issue_model_access":
      return {
        errorCode: "MODEL_CAPABILITY_INVALID",
        failureCode: "run.model_failed",
      };
    case "consume_events":
      return {
        errorCode: "AGENT_PROTOCOL_INVALID",
        failureCode: "run.agent_protocol_failed",
      };
    case "claim_run":
      return {
        errorCode: "RUN_STATE_CONFLICT",
        failureCode: "run.internal_failed",
      };
    default:
      return {
        errorCode: "UNEXPECTED",
        failureCode: "run.internal_failed",
      };
  }
}
