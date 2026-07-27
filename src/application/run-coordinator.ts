import type { AgentExecution, AgentRuntime, AgentRuntimeId } from "../agent/contract";
import { isTerminalAgentRun } from "../domain/agent-run";
import type { AgentRunStatus } from "../domain/agent-run";
import {
  type DiagnosticErrorCode,
  type DiagnosticReporter,
  type DiagnosticStage,
  noopDiagnosticReporter,
} from "../observability/contract";
import type {
  AgentRunRecord,
  AgentRunRepository,
  SandboxLeaseRecord,
  SandboxLeaseRepository,
} from "./ports";
import type { RuntimeKind, SandboxRuntime } from "../runtime/contract";
import type { AgentRunFailureCode, FailedAgentRunFailureCode } from "../shared/error-codes";

export type Clock = {
  now(): Date;
};

export type RunCoordinatorDependencies = {
  agentRunRepository: AgentRunRepository;
  clock: Clock;
  createId(): string;
  diagnostics?: DiagnosticReporter;
  getAgentRuntime(id: AgentRuntimeId): AgentRuntime;
  getSandboxRuntime(id: RuntimeKind): SandboxRuntime;
  sandboxLeaseRepository: SandboxLeaseRepository;
};

export type StartAgentRunInput = {
  agentRun: AgentRunRecord;
  modelAccess?: NonNullable<Parameters<AgentRuntime["start"]>[1]["modelAccess"]>;
  prompt: string;
  sandboxLease: SandboxLeaseRecord;
  workingDirectory: string;
};

export interface CoordinatedAgentRun {
  readonly completion: Promise<AgentRunRecord>;
  cancel(reason: "cancelled" | "timed_out" | "failed"): Promise<AgentRunRecord>;
}

/**
 * Coordinates one already-authorized AgentRun. It owns no IDs and does not
 * persist raw Agent output. It stores only the final user-visible reply.
 */
export class RunCoordinator {
  constructor(private readonly dependencies: RunCoordinatorDependencies) {}

  async start(input: StartAgentRunInput): Promise<CoordinatedAgentRun> {
    assertStartInput(input);

    const managedRun = new ManagedRun(this.dependencies, input);
    await managedRun.start();
    return managedRun;
  }
}

class ManagedRun implements CoordinatedAgentRun {
  readonly completion: Promise<AgentRunRecord>;

  private completionSettled = false;
  private currentLease: SandboxLeaseRecord;
  private currentRun: AgentRunRecord;
  private execution: AgentExecution | null = null;
  private readonly rejectCompletion: (reason: unknown) => void;
  private readonly resolveCompletion: (run: AgentRunRecord) => void;
  private lifecycle: Promise<void> = Promise.resolve();
  private providerRef: string | null;
  private terminal = false;

  constructor(
    private readonly dependencies: RunCoordinatorDependencies,
    private readonly input: StartAgentRunInput,
  ) {
    this.currentLease = input.sandboxLease;
    this.currentRun = input.agentRun;
    this.providerRef = input.sandboxLease.providerRef;

    let resolveCompletion: (run: AgentRunRecord) => void = () => undefined;
    let rejectCompletion: (reason: unknown) => void = () => undefined;
    this.completion = new Promise<AgentRunRecord>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    this.resolveCompletion = resolveCompletion;
    this.rejectCompletion = rejectCompletion;
  }

  async start() {
    let claimed = false;
    let startupStage: DiagnosticStage = "claim_run";

    try {
      await this.transition("queued", "starting", { startedAt: this.timestamp() });
      claimed = true;

      startupStage = "resolve_agent_runtime";
      const agentRuntime = this.dependencies.getAgentRuntime(this.currentRun.agentRuntimeId);
      if (agentRuntime.id !== this.currentRun.agentRuntimeId) {
        throw new Error("Registered AgentRuntime does not match AgentRun runtime");
      }

      startupStage = "resolve_sandbox_runtime";
      const sandboxRuntime = this.dependencies.getSandboxRuntime(this.currentLease.runtimeId);
      if (sandboxRuntime.kind !== this.currentRun.sandboxRuntimeId) {
        throw new Error("Registered SandboxRuntime does not match AgentRun runtime");
      }

      startupStage = "mark_lease_starting";
      await this.updateLease("starting");
      startupStage = "ensure_sandbox";
      const sandboxHandle = await sandboxRuntime.ensureLease({
        providerRef: this.currentLease.providerRef,
        projectId: this.currentRun.projectId,
        sandboxLeaseId: this.currentLease.id,
      });

      if (sandboxHandle.kind !== sandboxRuntime.kind) {
        throw new Error("SandboxRuntime returned a handle for a different runtime");
      }

      startupStage = "mark_lease_ready";
      this.providerRef = sandboxHandle.id;
      await this.updateLease("ready");
      startupStage = "start_agent";
      const execution = await agentRuntime.start(
        {
          files: {
            write: (path, content) => sandboxRuntime.writeFile(sandboxHandle, path, content),
          },
          processes: {
            start: (command) => sandboxRuntime.startProcess(sandboxHandle, command),
          },
        },
        {
          agentRunId: this.currentRun.id,
          modelAccess: this.input.modelAccess,
          projectId: this.currentRun.projectId,
          prompt: this.input.prompt,
          sandboxLeaseId: this.currentLease.id,
          workingDirectory: this.input.workingDirectory,
        },
      );
      this.execution = execution;
      startupStage = "persist_process_ref";
      const runWithProcessRef = await this.dependencies.agentRunRepository.setProviderProcessRef(
        this.currentRun.id,
        execution.providerProcessRef,
      );
      if (!runWithProcessRef) {
        throw new Error("Unable to persist AgentRun process reference");
      }
      this.currentRun = runWithProcessRef;

      startupStage = "mark_lease_busy";
      await this.updateLease("busy");
      startupStage = "mark_run_running";
      await this.transition("starting", "running");
      void this.consumeEvents();
    } catch (error) {
      if (!claimed) {
        throw error;
      }

      const failure = classifyStartupFailure(startupStage);
      await this.failSafely(failure.failureCode, failure.errorCode, startupStage);
    }
  }

  async cancel(reason: "cancelled" | "timed_out" | "failed"): Promise<AgentRunRecord> {
    return this.serialized(async () => {
      if (this.terminal) {
        return this.currentRun;
      }

      await this.refreshCurrentRun();
      if (isTerminalAgentRun(this.currentRun.status)) {
        this.terminal = true;
        this.resolve(this.currentRun);
        return this.currentRun;
      }

      if (this.execution) {
        if (this.currentRun.status === "starting" || this.currentRun.status === "running") {
          await this.transition(this.currentRun.status, "cancelling");
        }

        await this.execution.cancel(reason);
      }

      if (reason === "failed") {
        return this.fail("run.internal_failed", "UNEXPECTED", "cancel");
      }

      return this.complete(reason === "cancelled" ? "cancelled" : "timed_out");
    });
  }

  private async complete(
    status: "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted",
    failureCode?: AgentRunFailureCode,
    finalText?: string | null,
  ): Promise<AgentRunRecord> {
    if (this.terminal) {
      return this.currentRun;
    }

    const finishedAt = this.timestamp();

    if (status === "succeeded") {
      const visibleReply = finalText?.trim();
      if (!visibleReply && this.currentRun.sandboxRuntimeId !== "fake") {
        return this.fail("run.no_visible_reply", "AGENT_PROTOCOL_INVALID", "persist_completion");
      }

      const completedRun = await this.dependencies.agentRunRepository.completeSucceeded({
        assistantMessage: visibleReply
          ? {
              content: visibleReply,
              id: this.dependencies.createId(),
            }
          : null,
        finishedAt,
        runId: this.currentRun.id,
        sandboxDurationMs: this.calculateSandboxDuration(finishedAt),
      });
      if (!completedRun) {
        await this.refreshCurrentRun();
        if (isTerminalAgentRun(this.currentRun.status)) {
          this.terminal = true;
          this.resolve(this.currentRun);
          return this.currentRun;
        }
        if (this.currentRun.status === "cancelling") {
          return this.complete("cancelled");
        }
        throw new Error("Unable to complete running AgentRun");
      }

      this.currentRun = completedRun;
      this.terminal = true;
      return this.finishLease(completedRun);
    }

    await this.recordSandboxDuration(finishedAt);
    const completedRun = await this.transition(this.currentRun.status, status, {
      failureCode:
        failureCode ??
        (status === "timed_out"
          ? "run.timed_out"
          : status === "interrupted"
            ? "run.interrupted"
            : null),
      finishedAt,
    });
    this.terminal = true;

    return this.finishLease(completedRun);
  }

  private async finishLease(completedRun: AgentRunRecord) {
    try {
      await this.updateLease("idle");
      this.resolve(completedRun);
      return completedRun;
    } catch (error) {
      await this.markLeaseFailed();
      this.reject(error);
      throw error;
    }
  }

  private async consumeEvents() {
    try {
      const execution = this.execution;
      if (!execution) {
        throw new Error("Agent execution is unavailable");
      }

      for await (const event of execution.events()) {
        await this.serialized(async () => {
          if (this.terminal) {
            return;
          }

          if (event.type !== "agent.completed") {
            return;
          }

          await this.refreshCurrentRun();

          if (isTerminalAgentRun(this.currentRun.status)) {
            this.terminal = true;
            this.resolve(this.currentRun);
            return;
          }

          if (this.currentRun.status === "cancelling") {
            await this.complete("cancelled");
            return;
          }

          if (event.exitCode === 0) {
            await this.complete("succeeded", undefined, event.finalText);
            return;
          }

          this.reportFailure("AGENT_PROCESS_FAILED", "run.agent_process_failed", "consume_events");
          await this.complete("failed", "run.agent_process_failed");
        });

        if (this.terminal) {
          return;
        }
      }

      if (!this.terminal) {
        await this.serialized(() =>
          this.fail("run.agent_protocol_failed", "AGENT_PROTOCOL_INVALID", "consume_events"),
        );
      }
    } catch {
      if (!this.terminal) {
        await this.serialized(() =>
          this.failSafely("run.agent_protocol_failed", "AGENT_PROTOCOL_INVALID", "consume_events"),
        );
      }
    }
  }

  private async fail(
    failureCode: FailedAgentRunFailureCode,
    errorCode?: DiagnosticErrorCode,
    stage?: DiagnosticStage,
  ): Promise<AgentRunRecord> {
    if (this.terminal) {
      return this.currentRun;
    }

    if (errorCode) {
      this.reportFailure(errorCode, failureCode, stage);
    }

    await this.refreshCurrentRun();
    if (isTerminalAgentRun(this.currentRun.status)) {
      this.terminal = true;
      this.resolve(this.currentRun);
      return this.currentRun;
    }

    await this.terminateExecution();

    const finishedAt = this.timestamp();
    await this.recordSandboxDuration(finishedAt);
    const failedRun = await this.transition(this.currentRun.status, "failed", {
      failureCode,
      finishedAt,
    });
    this.terminal = true;

    try {
      await this.updateLease("failed");
      this.resolve(failedRun);
      return failedRun;
    } catch (error) {
      this.reject(error);
      throw error;
    }
  }

  private async failSafely(
    failureCode: FailedAgentRunFailureCode,
    errorCode?: DiagnosticErrorCode,
    stage?: DiagnosticStage,
  ): Promise<AgentRunRecord> {
    try {
      return await this.fail(failureCode, errorCode, stage);
    } catch (error) {
      this.reject(error);
      return this.currentRun;
    }
  }

  private async markLeaseFailed() {
    try {
      await this.updateLease("failed");
    } catch (_error) {
      // The primary completion failure is reported to the caller; there is no safe retry port yet.
    }
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(operation, operation);
    this.lifecycle = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async terminateExecution() {
    if (!this.execution) {
      return;
    }

    try {
      await this.execution.cancel("failed");
    } catch (_error) {
      // A failed process termination must not prevent D1 state from converging.
    }
  }

  private async transition(
    from: AgentRunStatus,
    to: AgentRunStatus,
    values: {
      failureCode?: AgentRunFailureCode | null;
      finishedAt?: string | null;
      startedAt?: string | null;
    } = {},
  ): Promise<AgentRunRecord> {
    const updatedRun = await this.dependencies.agentRunRepository.transition({
      ...values,
      from,
      runId: this.currentRun.id,
      to,
    });

    if (!updatedRun) {
      throw new Error(`Unable to transition AgentRun from ${from} to ${to}`);
    }

    this.currentRun = updatedRun;
    return updatedRun;
  }

  private async refreshCurrentRun() {
    const currentRun = await this.dependencies.agentRunRepository.findById(this.currentRun.id);

    if (!currentRun) {
      throw new Error(`AgentRun not found: ${this.currentRun.id}`);
    }

    this.currentRun = currentRun;
    return currentRun;
  }

  private async recordSandboxDuration(finishedAt: string) {
    if (this.currentRun.sandboxRuntimeId === "fake" || !this.currentRun.startedAt) {
      return;
    }

    const updatedRun = await this.dependencies.agentRunRepository.setSandboxDuration(
      this.currentRun.id,
      this.calculateSandboxDuration(finishedAt),
    );
    if (!updatedRun) {
      throw new Error("Unable to record AgentRun sandbox duration");
    }

    this.currentRun = updatedRun;
  }

  private calculateSandboxDuration(finishedAt: string) {
    if (this.currentRun.sandboxRuntimeId === "fake" || !this.currentRun.startedAt) {
      return 0;
    }

    return Math.max(
      0,
      new Date(finishedAt).getTime() - new Date(this.currentRun.startedAt).getTime(),
    );
  }

  private async updateLease(status: SandboxLeaseRecord["status"]) {
    const updatedLease = await this.dependencies.sandboxLeaseRepository.updateState({
      leaseId: this.currentLease.id,
      providerRef: this.providerRef,
      status,
      updatedAt: this.timestamp(),
    });

    this.currentLease = updatedLease;
    this.providerRef = updatedLease.providerRef;
    return updatedLease;
  }

  private reject(error: unknown) {
    if (this.completionSettled) {
      return;
    }

    this.completionSettled = true;
    this.rejectCompletion(error);
  }

  private resolve(run: AgentRunRecord) {
    if (this.completionSettled) {
      return;
    }

    this.completionSettled = true;
    this.resolveCompletion(run);
  }

  private timestamp() {
    return this.dependencies.clock.now().toISOString();
  }

  private reportFailure(
    errorCode: DiagnosticErrorCode,
    failureCode: FailedAgentRunFailureCode,
    stage?: DiagnosticStage,
  ) {
    (this.dependencies.diagnostics ?? noopDiagnosticReporter).report({
      agentRuntimeId: this.currentRun.agentRuntimeId,
      errorCode,
      event: "agent_run.stage_failed",
      failureCode,
      modelId: this.currentRun.modelId,
      outcome: "failed",
      runId: this.currentRun.id,
      runStatus: this.currentRun.status,
      sandboxRuntimeId: this.currentRun.sandboxRuntimeId,
      stage,
    });
  }
}

function assertStartInput(input: StartAgentRunInput) {
  const { agentRun, sandboxLease } = input;

  if (agentRun.status !== "queued") {
    throw new Error("RunCoordinator can only start a queued AgentRun");
  }

  if (agentRun.projectId !== sandboxLease.projectId) {
    throw new Error("AgentRun and SandboxLease must belong to the same Project");
  }

  if (agentRun.sandboxLeaseId !== sandboxLease.id) {
    throw new Error("AgentRun must use the supplied SandboxLease");
  }

  if (agentRun.sandboxRuntimeId !== sandboxLease.runtimeId) {
    throw new Error("AgentRun and SandboxLease must use the same SandboxRuntime");
  }

  if (isTerminalAgentRun(agentRun.status)) {
    throw new Error("RunCoordinator cannot start a terminal AgentRun");
  }
}

function classifyStartupFailure(stage: DiagnosticStage): {
  errorCode: DiagnosticErrorCode;
  failureCode: FailedAgentRunFailureCode;
} {
  switch (stage) {
    case "ensure_sandbox":
      return {
        errorCode: "SANDBOX_ENSURE_FAILED",
        failureCode: "run.sandbox_failed",
      };
    case "resolve_sandbox_runtime":
    case "mark_lease_starting":
    case "mark_lease_ready":
    case "mark_lease_busy":
      return {
        errorCode: "LEASE_INCONSISTENT",
        failureCode: "run.sandbox_failed",
      };
    case "resolve_agent_runtime":
    case "start_agent":
      return {
        errorCode: "AGENT_PROCESS_FAILED",
        failureCode: "run.start_failed",
      };
    case "claim_run":
    case "persist_process_ref":
    case "mark_run_running":
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
