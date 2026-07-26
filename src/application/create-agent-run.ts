import type { AgentRuntimeId } from "../agent/contract";
import type { RuntimeKind } from "../runtime/contract";
import type {
  AgentRunRecord,
  AgentRunRepository,
  SandboxLeaseRepository,
} from "./ports";
import type { StartAgentRunInput } from "./run-coordinator";

export type AgentRunExecutionStartResult = {
  completion: Promise<AgentRunRecord> | null;
};

export interface AgentRunExecutionStarter {
  start(input: StartAgentRunInput): Promise<AgentRunExecutionStartResult>;
}

export type CreateAgentRunResult =
  | {
      completion: Promise<AgentRunRecord> | null;
      kind: "created";
      run: AgentRunRecord;
    }
  | { kind: "project_busy" }
  | { kind: "runtime_mismatch" };

export type CreateAgentRunServiceDependencies = {
  agentRuns: AgentRunRepository;
  clock: { now(): Date };
  createId(): string;
  defaultModelId: string;
  runExecutions: AgentRunExecutionStarter;
  sandboxLeases: SandboxLeaseRepository;
  sandboxRuntimeId: RuntimeKind;
  workingDirectory: string;
};

/**
 * Creates one already-authorized AgentRun and dispatches its execution owner.
 * HTTP concerns and runtime-publication policy stay outside this use case.
 */
export class CreateAgentRunService {
  constructor(
    private readonly dependencies: CreateAgentRunServiceDependencies,
  ) {}

  async create(input: {
    agentRuntimeId: AgentRuntimeId;
    content: string;
    projectId: string;
    userId: string;
  }): Promise<CreateAgentRunResult> {
    const now = this.dependencies.clock.now().toISOString();
    const sandboxLease = await this.dependencies.sandboxLeases.getOrCreate({
      id: this.dependencies.createId(),
      now,
      projectId: input.projectId,
      runtimeId: this.dependencies.sandboxRuntimeId,
    });
    if (sandboxLease.runtimeId !== this.dependencies.sandboxRuntimeId) {
      return { kind: "runtime_mismatch" };
    }

    const created = await this.dependencies.agentRuns.createQueuedWithInput({
      agentRunId: this.dependencies.createId(),
      agentRuntimeId: input.agentRuntimeId,
      content: input.content,
      inputMessageId: this.dependencies.createId(),
      modelId: this.dependencies.defaultModelId,
      now,
      projectId: input.projectId,
      sandboxLeaseId: sandboxLease.id,
      sandboxRuntimeId: sandboxLease.runtimeId,
      userId: input.userId,
    });
    if (created.kind === "project_busy") {
      return created;
    }

    try {
      const execution = await this.dependencies.runExecutions.start({
        agentRun: created.run,
        prompt: input.content,
        sandboxLease,
        workingDirectory: this.dependencies.workingDirectory,
      });
      return {
        completion: execution.completion,
        kind: "created",
        run: created.run,
      };
    } catch (_error) {
      const failed = await this.dependencies.agentRuns.transition({
        failureReason: "Agent run could not be started",
        finishedAt: this.dependencies.clock.now().toISOString(),
        from: "queued",
        runId: created.run.id,
        to: "failed",
      });
      const current =
        failed ??
        (await this.dependencies.agentRuns.findById(created.run.id));
      if (!current || current.status === "queued") {
        throw new Error("AgentRun startup failure did not converge");
      }

      return {
        completion: null,
        kind: "created",
        run: current,
      };
    }
  }
}
