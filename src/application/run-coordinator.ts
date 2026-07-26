import type { AgentExecution, AgentRuntime, AgentRuntimeId } from "../agent/contract";
import { isTerminalAgentRun } from "../domain/agent-run";
import type { AgentRunStatus } from "../domain/agent-run";
import type {
  AgentRunRecord,
  AgentRunRepository,
  MessageRepository,
  SandboxLeaseRecord,
  SandboxLeaseRepository,
} from "./ports";
import type { RuntimeHandle, RuntimeKind, SandboxRuntime } from "../runtime/contract";

export type Clock = {
  now(): Date;
};

export type RunCoordinatorDependencies = {
  agentRunRepository: AgentRunRepository;
  clock: Clock;
  createId(): string;
  getAgentRuntime(id: AgentRuntimeId): AgentRuntime;
  getSandboxRuntime(id: RuntimeKind): SandboxRuntime;
  messageRepository: MessageRepository;
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

  private agentRuntime: AgentRuntime | null = null;
  private completionSettled = false;
  private currentLease: SandboxLeaseRecord;
  private currentRun: AgentRunRecord;
  private execution: AgentExecution | null = null;
  private readonly rejectCompletion: (reason: unknown) => void;
  private readonly resolveCompletion: (run: AgentRunRecord) => void;
  private lifecycle: Promise<void> = Promise.resolve();
  private providerRef: string | null;
  private sandboxHandle: RuntimeHandle | null = null;
  private sandboxRuntime: SandboxRuntime | null = null;
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

    try {
      await this.transition("queued", "starting", { startedAt: this.timestamp() });
      claimed = true;

      this.agentRuntime = this.dependencies.getAgentRuntime(this.currentRun.agentRuntimeId);
      if (this.agentRuntime.id !== this.currentRun.agentRuntimeId) {
        throw new Error("Registered AgentRuntime does not match AgentRun runtime");
      }

      this.sandboxRuntime = this.dependencies.getSandboxRuntime(this.currentLease.runtimeId);
      if (this.sandboxRuntime.kind !== this.currentRun.sandboxRuntimeId) {
        throw new Error("Registered SandboxRuntime does not match AgentRun runtime");
      }

      await this.updateLease("starting");
      this.sandboxHandle = await this.sandboxRuntime.ensureLease({
        providerRef: this.currentLease.providerRef,
        projectId: this.currentRun.projectId,
        sandboxLeaseId: this.currentLease.id,
      });

      if (this.sandboxHandle.kind !== this.sandboxRuntime.kind) {
        throw new Error("SandboxRuntime returned a handle for a different runtime");
      }

      this.providerRef = this.sandboxHandle.id;
      await this.updateLease("ready");
      this.execution = await this.agentRuntime.start({
        files: {
          write: (path, content) => this.sandboxRuntime!.writeFile(this.sandboxHandle!, path, content),
        },
        processes: {
          start: (command) => this.sandboxRuntime!.startProcess(this.sandboxHandle!, command),
        },
      }, {
        agentRunId: this.currentRun.id,
        modelAccess: this.input.modelAccess,
        projectId: this.currentRun.projectId,
        prompt: this.input.prompt,
        sandboxLeaseId: this.currentLease.id,
        workingDirectory: this.input.workingDirectory,
      });
      const runWithProcessRef = await this.dependencies.agentRunRepository.setProviderProcessRef(
        this.currentRun.id,
        this.execution.providerProcessRef,
      );
      if (!runWithProcessRef) {
        throw new Error("Unable to persist AgentRun process reference");
      }
      this.currentRun = runWithProcessRef;

      await this.updateLease("busy");
      await this.transition("starting", "running");
      void this.consumeEvents();
    } catch (error) {
      if (!claimed) {
        throw error;
      }

      await this.failSafely("Agent run startup failed");
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
        return this.fail("Agent run was terminated");
      }

      return this.complete(reason === "cancelled" ? "cancelled" : "timed_out");
    });
  }

  private async complete(
    status: "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted",
    failureReason?: string,
    finalText?: string | null,
  ): Promise<AgentRunRecord> {
    if (this.terminal) {
      return this.currentRun;
    }

    const finishedAt = this.timestamp();

    if (status === "succeeded") {
      const visibleReply = finalText?.trim();
      if (!visibleReply && this.currentRun.sandboxRuntimeId !== "fake") {
        return this.fail("Agent completed without a visible reply");
      }

      if (visibleReply) {
        await this.dependencies.messageRepository.appendAssistant({
          agentRunId: this.currentRun.id,
          content: visibleReply,
          id: this.dependencies.createId(),
          now: finishedAt,
          projectId: this.currentRun.projectId,
        });
      }
    }

    await this.recordSandboxDuration(finishedAt);

    const completedRun = await this.transition(this.currentRun.status, status, {
      failureReason: failureReason ?? null,
      finishedAt,
    });
    this.terminal = true;

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
      for await (const event of this.execution!.events()) {
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

          await this.complete("failed", `Agent process exited with code ${event.exitCode}`);
        });

        if (this.terminal) {
          return;
        }
      }

      if (!this.terminal) {
        await this.serialized(() => this.fail("Agent runtime ended without a completion event"));
      }
    } catch (_error) {
      if (!this.terminal) {
        await this.serialized(() => this.failSafely("Agent runtime failed"));
      }
    }
  }

  private async fail(reason: string): Promise<AgentRunRecord> {
    if (this.terminal) {
      return this.currentRun;
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
      failureReason: reason,
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

  private async failSafely(reason: string): Promise<AgentRunRecord> {
    try {
      return await this.fail(reason);
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
      failureReason?: string | null;
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

    const sandboxDurationMs = Math.max(
      0,
      new Date(finishedAt).getTime() - new Date(this.currentRun.startedAt).getTime(),
    );
    const updatedRun = await this.dependencies.agentRunRepository.setSandboxDuration(
      this.currentRun.id,
      sandboxDurationMs,
    );
    if (!updatedRun) {
      throw new Error("Unable to record AgentRun sandbox duration");
    }

    this.currentRun = updatedRun;
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
