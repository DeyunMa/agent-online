import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { AgentRuntimeId } from "../agent/contract";
import type {
  AgentRunRecord,
  AgentRunRepository,
  AgentRunUsage,
  CreateQueuedAgentRunResult,
  MessageRecord,
  MessageRepository,
  ProjectRecord,
  ProjectRepository,
  SandboxLeaseRecord,
  SandboxLeaseRepository,
  TerminalSessionRepository,
} from "../application/ports";
import { CreateAgentRunService } from "../application/create-agent-run";
import { ProjectFilesService } from "../application/project-files";
import type { CoordinatedAgentRun, StartAgentRunInput } from "../application/run-coordinator";
import { ProjectSandboxService } from "../application/project-sandbox";
import { ProjectTerminalService } from "../application/project-terminal";
import { canTransitionAgentRun, isTerminalAgentRun } from "../domain/agent-run";
import { FakeSandboxRuntime } from "../runtime/fake-runtime";
import type {
  AgentRunResponse,
  MessageResponse,
  ProjectDirectoryResponse,
  ProjectFileResponse,
  ProjectResponse,
} from "../shared/api";
import type { AppEnv } from "./env";
import { createProjectApi } from "./project-api";
import type { ServerServices } from "./services";
import type { RunExecutionDispatcher } from "./services";

const testUser = { email: "user@example.test", id: "user_1" };
const otherUser = { email: "other@example.test", id: "user_2" };
const now = "2026-07-25T00:00:00.000Z";

describe("Project API", () => {
  it("rejects an unauthenticated request before accessing product data", async () => {
    const fixture = createFixture(null);

    const response = await fixture.app.request("http://agent-online.test/api/projects");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "unauthorized",
      requestId: "test-request",
    });
  });

  it("creates and lists only the authenticated user's Projects", async () => {
    const fixture = createFixture(testUser);
    await fixture.projects.create({
      defaultAgentRuntimeId: "pi",
      id: "project_other",
      now,
      title: "Other Project",
      userId: otherUser.id,
    });

    const createdResponse = await fixture.app.request("http://agent-online.test/api/projects", {
      body: JSON.stringify({ title: "  Personal App  " }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const created = (await createdResponse.json()) as ProjectResponse;

    expect(createdResponse.status).toBe(201);
    expect(created).toMatchObject({ sandboxLease: null, title: "Personal App" });

    const listedResponse = await fixture.app.request("http://agent-online.test/api/projects");
    const listed = (await listedResponse.json()) as ProjectResponse[];

    expect(listedResponse.status).toBe(200);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: created.id, title: "Personal App" });
    expect(JSON.stringify(listed)).not.toContain("user_1");
  });

  it("validates input and hides another user's Project as not found", async () => {
    const fixture = createFixture(testUser);
    await fixture.projects.create({
      defaultAgentRuntimeId: "pi",
      id: "project_other",
      now,
      title: "Other Project",
      userId: otherUser.id,
    });

    const invalid = await fixture.app.request("http://agent-online.test/api/projects", {
      body: JSON.stringify({ title: "   " }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const inaccessible = await fixture.app.request(
      "http://agent-online.test/api/projects/project_other/messages",
    );

    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: "validation_error" });
    expect(inaccessible.status).toBe(404);
    await expect(inaccessible.json()).resolves.toMatchObject({ error: "not_found" });
  });

  it("stops an owned Project sandbox without exposing its provider reference", async () => {
    const fixture = createFixture(testUser);
    await fixture.projects.create({
      defaultAgentRuntimeId: "pi",
      id: "project_1",
      now,
      title: "Demo",
      userId: testUser.id,
    });
    const lease = await fixture.sandboxLeases.getOrCreate({
      id: "lease_1",
      now,
      projectId: "project_1",
      runtimeId: "fake",
    });
    await fixture.sandboxLeases.updateState({
      leaseId: lease.id,
      providerRef: "provider-private-sandbox",
      status: "idle",
      updatedAt: now,
    });

    const response = await fixture.app.request(
      "http://agent-online.test/api/projects/project_1/sandbox/stop",
      { method: "POST" },
    );
    const body = (await response.json()) as ProjectResponse;

    expect(response.status).toBe(200);
    expect(body.sandboxLease).toMatchObject({
      id: lease.id,
      runtimeId: "fake",
      status: "stopped",
    });
    expect(JSON.stringify(body)).not.toContain("provider-private-sandbox");
    expect(JSON.stringify(body)).not.toContain("providerRef");
  });

  it("rejects a manual sandbox stop while the Project has an active Run", async () => {
    const fixture = createFixture(testUser);
    await fixture.projects.create({
      defaultAgentRuntimeId: "pi",
      id: "project_1",
      now,
      title: "Demo",
      userId: testUser.id,
    });
    await fixture.app.request("http://agent-online.test/api/projects/project_1/agent-runs", {
      body: JSON.stringify({ content: "Build a demo" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const lease = await fixture.sandboxLeases.findByProjectId("project_1");
    await fixture.sandboxLeases.updateState({
      leaseId: lease?.id ?? "",
      providerRef: "provider-private-sandbox",
      status: "busy",
      updatedAt: now,
    });

    const response = await fixture.app.request(
      "http://agent-online.test/api/projects/project_1/sandbox/stop",
      { method: "POST" },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "project_busy",
    });
  });

  it("lists and reads owned Project files without exposing provider details", async () => {
    const fixture = createFixture(testUser);
    await fixture.projects.create({
      defaultAgentRuntimeId: "pi",
      id: "project_1",
      now,
      title: "Demo",
      userId: testUser.id,
    });
    const lease = await fixture.sandboxLeases.getOrCreate({
      id: "lease_1",
      now,
      projectId: "project_1",
      runtimeId: "fake",
    });
    const handle = await fixture.sandboxRuntime.ensureLease({
      projectId: "project_1",
      providerRef: "provider-private-sandbox",
      sandboxLeaseId: lease.id,
    });
    await fixture.sandboxRuntime.writeFile(handle, "/workspace/src/index.ts", "export {};\n");
    await fixture.sandboxLeases.updateState({
      leaseId: lease.id,
      providerRef: handle.id,
      status: "idle",
      updatedAt: now,
    });

    const listResponse = await fixture.app.request(
      "http://agent-online.test/api/projects/project_1/files?path=src",
    );
    const list = (await listResponse.json()) as ProjectDirectoryResponse;
    const fileResponse = await fixture.app.request(
      "http://agent-online.test/api/projects/project_1/files/content?path=src%2Findex.ts",
    );
    const file = (await fileResponse.json()) as ProjectFileResponse;

    expect(listResponse.status).toBe(200);
    expect(list.entries).toMatchObject([{ kind: "file", name: "index.ts", path: "src/index.ts" }]);
    expect(fileResponse.status).toBe(200);
    expect(file).toMatchObject({
      content: "export {};\n",
      path: "src/index.ts",
    });
    expect(JSON.stringify([list, file])).not.toContain(handle.id);
    expect(JSON.stringify([list, file])).not.toContain("providerRef");
  });

  it("creates one visible input message and one queued Run, without exposing private lease details", async () => {
    const fixture = createFixture(testUser);
    await fixture.projects.create({
      defaultAgentRuntimeId: "pi",
      id: "project_1",
      now,
      title: "Demo",
      userId: testUser.id,
    });

    const createdResponse = await fixture.app.request(
      "http://agent-online.test/api/projects/project_1/agent-runs",
      {
        body: JSON.stringify({ content: "  Build a demo  " }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    const created = (await createdResponse.json()) as AgentRunResponse;
    const messagesResponse = await fixture.app.request(
      "http://agent-online.test/api/projects/project_1/messages",
    );
    const messages = (await messagesResponse.json()) as MessageResponse[];
    const activeResponse = await fixture.app.request(
      "http://agent-online.test/api/projects/project_1/agent-runs/active",
    );
    const active = (await activeResponse.json()) as AgentRunResponse;
    const secondResponse = await fixture.app.request(
      "http://agent-online.test/api/projects/project_1/agent-runs",
      {
        body: JSON.stringify({ content: "Try a second Run" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );

    expect(createdResponse.status).toBe(201);
    expect(created).toMatchObject({
      agentRuntimeId: "pi",
      sandboxRuntimeId: "fake",
      status: "queued",
    });
    expect(JSON.stringify(created)).not.toContain("providerRef");
    expect(fixture.coordinator.starts).toHaveLength(1);
    expect(fixture.coordinator.starts[0]).toMatchObject({
      prompt: "Build a demo",
      workingDirectory: "/workspace",
    });
    expect(messages).toMatchObject([{ content: "Build a demo", role: "user", sequence: 0 }]);
    expect(JSON.stringify(messages)).not.toContain("projectId");
    expect(activeResponse.status).toBe(200);
    expect(active).toMatchObject({ id: created.id, status: "queued" });
    expect(secondResponse.status).toBe(409);
    await expect(secondResponse.json()).resolves.toMatchObject({ error: "project_busy" });
  });

  it("persists an explicitly selected enabled AgentRuntime", async () => {
    const fixture = createFixture(testUser, {
      enabledAgentRuntimeIds: ["pi", "goose"],
    });
    await fixture.projects.create({
      defaultAgentRuntimeId: "pi",
      id: "project_1",
      now,
      title: "Demo",
      userId: testUser.id,
    });

    const response = await fixture.app.request(
      "http://agent-online.test/api/projects/project_1/agent-runs",
      {
        body: JSON.stringify({
          agentRuntimeId: "goose",
          content: "Inspect this project",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      agentRuntimeId: "goose",
      status: "queued",
    });
    expect(fixture.coordinator.starts[0]?.agentRun.agentRuntimeId).toBe("goose");
  });

  it("rejects a gated AgentRuntime before creating product state", async () => {
    const fixture = createFixture(testUser);
    await fixture.projects.create({
      defaultAgentRuntimeId: "pi",
      id: "project_1",
      now,
      title: "Demo",
      userId: testUser.id,
    });

    const response = await fixture.app.request(
      "http://agent-online.test/api/projects/project_1/agent-runs",
      {
        body: JSON.stringify({
          agentRuntimeId: "goose",
          content: "Inspect this project",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "agent_runtime_unavailable",
    });
    expect(fixture.agentRuns.records.size).toBe(0);
    expect(fixture.messages.records).toHaveLength(0);
    await expect(fixture.sandboxLeases.findByProjectId("project_1")).resolves.toBeNull();
    expect(fixture.coordinator.starts).toHaveLength(0);
  });

  it("rejects new Runs before creating product state when Runs are paused", async () => {
    const fixture = createFixture(testUser, { runsEnabled: false });
    await fixture.projects.create({
      defaultAgentRuntimeId: "pi",
      id: "project_1",
      now,
      title: "Demo",
      userId: testUser.id,
    });

    const response = await fixture.app.request(
      "http://agent-online.test/api/projects/project_1/agent-runs",
      {
        body: JSON.stringify({ content: "Build a demo" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "runs_disabled",
    });
    expect(fixture.agentRuns.records.size).toBe(0);
    expect(fixture.messages.records).toHaveLength(0);
    await expect(fixture.sandboxLeases.findByProjectId("project_1")).resolves.toBeNull();
    expect(fixture.coordinator.starts).toHaveLength(0);
  });

  it("streams terminal fake Run state from D1 without a live registry", async () => {
    const fixture = createFixture(testUser);
    await fixture.projects.create({
      defaultAgentRuntimeId: "pi",
      id: "project_1",
      now,
      title: "Demo",
      userId: testUser.id,
    });

    const createdResponse = await fixture.app.request(
      "http://agent-online.test/api/projects/project_1/agent-runs",
      {
        body: JSON.stringify({ content: "Build a demo" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    const created = (await createdResponse.json()) as AgentRunResponse;
    const cancellationResponse = await fixture.app.request(
      `http://agent-online.test/api/projects/project_1/agent-runs/${created.id}/cancel`,
      { method: "POST" },
    );
    const streamResponse = await fixture.app.request(
      `http://agent-online.test/api/projects/project_1/agent-runs/${created.id}/events`,
    );
    const streamText = await streamResponse.text();

    expect(cancellationResponse.status).toBe(200);
    await expect(cancellationResponse.json()).resolves.toMatchObject({ status: "cancelled" });
    expect(streamResponse.status).toBe(200);
    expect(streamText).toContain('"type":"run.status"');
    expect(streamText).toContain('"status":"cancelled"');
    expect(streamText).toContain('"type":"run.completed"');
  });

  it("lists recent Runs only after authorizing the Project owner", async () => {
    const fixture = createFixture(testUser);
    await fixture.projects.create({
      defaultAgentRuntimeId: "pi",
      id: "project_1",
      now,
      title: "Demo",
      userId: testUser.id,
    });
    await fixture.projects.create({
      defaultAgentRuntimeId: "pi",
      id: "project_other",
      now,
      title: "Other",
      userId: otherUser.id,
    });

    const createdResponse = await fixture.app.request(
      "http://agent-online.test/api/projects/project_1/agent-runs",
      {
        body: JSON.stringify({ content: "Build a demo" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    const created = (await createdResponse.json()) as AgentRunResponse;
    const historyResponse = await fixture.app.request(
      "http://agent-online.test/api/projects/project_1/agent-runs",
    );
    const history = (await historyResponse.json()) as AgentRunResponse[];
    const inaccessible = await fixture.app.request(
      "http://agent-online.test/api/projects/project_other/agent-runs",
    );

    expect(historyResponse.status).toBe(200);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: created.id, inputMessageId: created.inputMessageId });
    expect(JSON.stringify(history)).not.toContain(testUser.id);
    expect(inaccessible.status).toBe(404);
  });
});

function createFixture(
  user: typeof testUser | null,
  options: {
    enabledAgentRuntimeIds?: readonly AgentRuntimeId[];
    runsEnabled?: boolean;
  } = {},
) {
  const projects = new InMemoryProjectRepository();
  const messages = new InMemoryMessageRepository();
  const agentRuns = new InMemoryAgentRunRepository(messages);
  const sandboxLeases = new InMemorySandboxLeaseRepository();
  const coordinator = new FakeRunCoordinator(agentRuns);
  const sandboxRuntime = new PersistentFakeSandboxRuntime();
  let id = 0;
  const createId = () => `id_${++id}`;
  const createAgentRuns = new CreateAgentRunService({
    agentRuns,
    clock: { now: () => new Date(now) },
    createId,
    defaultModelId: "gemini-3.6-flash",
    runExecutions: coordinator,
    sandboxLeases,
    sandboxRuntimeId: "fake",
    workingDirectory: "/workspace",
  });
  const terminalSessions = {
    claim: async () => ({ kind: "project_busy" as const }),
    findById: async () => null,
    findByProjectId: async () => null,
    markLeaseFailedKeepingSession: async () => false,
    release: async () => false,
    releaseAndMarkLeaseIdle: async () => false,
    releaseAndMarkLeaseStopped: async () => false,
    setProviderProcessRef: async () => null,
    setProviderSandboxRef: async () => null,
  } satisfies TerminalSessionRepository;
  const previewSessions = {
    findByProjectId: async () => null,
  };
  const services: ServerServices = {
    agentRuns,
    createAgentRuns,
    enabledAgentRuntimeIds: options.enabledAgentRuntimeIds ?? ["pi"],
    messages,
    projectChanges: {} as ServerServices["projectChanges"],
    projectFiles: new ProjectFilesService({
      agentRuns,
      getSandboxRuntime: () => sandboxRuntime,
      now: () => new Date(now),
      sandboxLeases,
      terminalSessions,
      workingDirectory: "/workspace",
    }),
    projectPreviews: {} as ServerServices["projectPreviews"],
    projectSandboxes: new ProjectSandboxService({
      agentRuns,
      getSandboxRuntime: () => sandboxRuntime,
      now: () => new Date(now),
      previewSessions,
      sandboxLeases,
      terminalSessions,
    }),
    projectTerminals: new ProjectTerminalService({
      agentRuns,
      clock: { now: () => new Date(now) },
      createId,
      getSandboxRuntime: () => null,
      sandboxLeases,
      sandboxRuntimeId: "fake",
      scheduleExpiry: async () => undefined,
      scheduleIdleCleanup: async () => undefined,
      terminalSessions,
      workingDirectory: "/workspace",
    }),
    projects,
    runExecutions: coordinator,
    sandboxLeases,
  };
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("requestId", "test-request");
    await next();
  });
  app.route(
    "/api",
    createProjectApi({
      createId,
      createServices: () => services,
      getDeploymentPolicy: () => ({
        accessMode: "open",
        allowedEmails: null,
        runsEnabled: options.runsEnabled ?? true,
      }),
      getAuthenticatedUser: async () => user,
      now: () => new Date(now),
    }),
  );

  return {
    agentRuns,
    app,
    coordinator,
    messages,
    projects,
    sandboxLeases,
    sandboxRuntime,
  };
}

class PersistentFakeSandboxRuntime extends FakeSandboxRuntime {
  override readonly filesystemScope = "lease" as const;
}

class InMemoryProjectRepository implements ProjectRepository {
  readonly records = new Map<string, ProjectRecord>();

  async create(input: Omit<ProjectRecord, "createdAt" | "updatedAt"> & { now: string }) {
    const project: ProjectRecord = {
      createdAt: input.now,
      defaultAgentRuntimeId: input.defaultAgentRuntimeId,
      id: input.id,
      title: input.title,
      updatedAt: input.now,
      userId: input.userId,
    };
    this.records.set(project.id, project);
    return project;
  }

  async findOwnedById(projectId: string, userId: string) {
    const project = this.records.get(projectId);
    return project?.userId === userId ? project : null;
  }

  async listOwned(userId: string) {
    return [...this.records.values()].filter((project) => project.userId === userId);
  }
}

class InMemoryMessageRepository implements MessageRepository {
  readonly records: MessageRecord[] = [];

  async findById(messageId: string, projectId: string) {
    return (
      this.records.find((message) => message.id === messageId && message.projectId === projectId) ??
      null
    );
  }

  async listByProjectId(projectId: string) {
    return this.records
      .filter((message) => message.projectId === projectId)
      .sort((left, right) => left.sequence - right.sequence);
  }
}

class InMemorySandboxLeaseRepository implements SandboxLeaseRepository {
  readonly records = new Map<string, SandboxLeaseRecord>();

  async claimIdleAfterActivityForStop(
    input: Parameters<SandboxLeaseRepository["claimIdleAfterActivityForStop"]>[0],
  ) {
    const lease = this.records.get(input.leaseId);
    if (
      lease?.status !== "idle" ||
      lease.providerRef !== input.expectedProviderRef ||
      lease.updatedAt !== input.expectedUpdatedAt
    ) {
      return false;
    }

    Object.assign(lease, {
      providerRef: null,
      status: "stopped",
      updatedAt: input.updatedAt,
    });
    return true;
  }

  async claimForManualStop(input: Parameters<SandboxLeaseRepository["claimForManualStop"]>[0]) {
    const lease = this.records.get(input.leaseId);
    if (
      !lease ||
      lease.providerRef !== input.expectedProviderRef ||
      lease.updatedAt !== input.expectedUpdatedAt
    ) {
      return false;
    }

    Object.assign(lease, {
      providerRef: null,
      status: "stopped",
      updatedAt: input.updatedAt,
    });
    return true;
  }

  async claimIdleForStop(input: Parameters<SandboxLeaseRepository["claimIdleForStop"]>[0]) {
    const lease = this.records.get(input.leaseId);
    if (
      lease?.status !== "idle" ||
      lease.providerRef !== input.expectedProviderRef ||
      lease.updatedAt !== input.expectedUpdatedAt
    ) {
      return false;
    }

    Object.assign(lease, {
      providerRef: null,
      status: "stopped",
      updatedAt: input.updatedAt,
    });
    return true;
  }

  async findByProjectId(projectId: string) {
    return [...this.records.values()].find((lease) => lease.projectId === projectId) ?? null;
  }

  async getOrCreate(input: {
    id: string;
    now: string;
    projectId: string;
    runtimeId: "fake" | "e2b" | "cloudflare-container";
  }) {
    const current = await this.findByProjectId(input.projectId);
    if (current) {
      return current;
    }

    const lease: SandboxLeaseRecord = {
      createdAt: input.now,
      id: input.id,
      projectId: input.projectId,
      providerRef: null,
      runtimeId: input.runtimeId,
      status: "stopped",
      updatedAt: input.now,
    };
    this.records.set(lease.id, lease);
    return lease;
  }

  async updateState(input: {
    leaseId: string;
    providerRef: string | null;
    status: SandboxLeaseRecord["status"];
    updatedAt: string;
  }) {
    const lease = this.records.get(input.leaseId);
    if (!lease) {
      throw new Error("Lease not found");
    }

    Object.assign(lease, {
      providerRef: input.providerRef,
      status: input.status,
      updatedAt: input.updatedAt,
    });
    return lease;
  }
}

class InMemoryAgentRunRepository implements AgentRunRepository {
  readonly records = new Map<string, AgentRunRecord>();

  constructor(private readonly messages: InMemoryMessageRepository) {}

  async createQueuedWithInput(
    input: Parameters<AgentRunRepository["createQueuedWithInput"]>[0],
  ): Promise<CreateQueuedAgentRunResult> {
    const activeRun = [...this.records.values()].find(
      (run) => run.projectId === input.projectId && !isTerminalAgentRun(run.status),
    );
    if (activeRun) {
      return { kind: "project_busy" };
    }

    const inputMessage: MessageRecord = {
      agentRunId: null,
      content: input.content,
      createdAt: input.now,
      id: input.inputMessageId,
      projectId: input.projectId,
      role: "user",
      sequence: this.messages.records.filter((message) => message.projectId === input.projectId)
        .length,
    };
    const run: AgentRunRecord = {
      agentRuntimeId: input.agentRuntimeId,
      createdAt: input.now,
      failureReason: null,
      finishedAt: null,
      id: input.agentRunId,
      inputMessageId: input.inputMessageId,
      modelId: input.modelId,
      projectId: input.projectId,
      providerProcessRef: null,
      sandboxLeaseId: input.sandboxLeaseId,
      sandboxRuntimeId: input.sandboxRuntimeId,
      startedAt: null,
      status: "queued",
      usage: emptyUsage(),
      userId: input.userId,
    };

    this.messages.records.push(inputMessage);
    this.records.set(run.id, run);
    return { inputMessage, kind: "created", run };
  }

  async findById(agentRunId: string) {
    return this.records.get(agentRunId) ?? null;
  }

  async findActiveByProjectId(projectId: string) {
    return (
      [...this.records.values()].find(
        (run) => run.projectId === projectId && !isTerminalAgentRun(run.status),
      ) ?? null
    );
  }

  async findActiveOwnedByProjectId(projectId: string, userId: string) {
    return (
      [...this.records.values()].find(
        (run) =>
          run.projectId === projectId && run.userId === userId && !isTerminalAgentRun(run.status),
      ) ?? null
    );
  }

  async findOwnedById(agentRunId: string, userId: string) {
    const run = this.records.get(agentRunId);
    return run?.userId === userId ? run : null;
  }

  async listRecentOwnedByProjectId(projectId: string, userId: string) {
    return [...this.records.values()]
      .filter((run) => run.projectId === projectId && run.userId === userId)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      )
      .slice(0, 50);
  }

  async setProviderProcessRef(runId: string, providerProcessRef: string) {
    const run = this.records.get(runId);
    if (!run || isTerminalAgentRun(run.status)) {
      return null;
    }

    run.providerProcessRef = providerProcessRef;
    return run;
  }

  async setSandboxDuration(runId: string, sandboxDurationMs: number) {
    const run = this.records.get(runId);
    if (!run || isTerminalAgentRun(run.status)) {
      return null;
    }

    run.usage.sandboxDurationMs = Math.max(run.usage.sandboxDurationMs, sandboxDurationMs);
    return run;
  }

  async addUsageDelta(runId: string, usage: AgentRunUsage) {
    const run = this.records.get(runId);
    if (!run || isTerminalAgentRun(run.status)) {
      return null;
    }

    run.usage = {
      inputTokens: run.usage.inputTokens + usage.inputTokens,
      modelRequestCount: run.usage.modelRequestCount + usage.modelRequestCount,
      outputTokens: run.usage.outputTokens + usage.outputTokens,
      sandboxDurationMs: run.usage.sandboxDurationMs + usage.sandboxDurationMs,
      totalTokens: run.usage.totalTokens + usage.totalTokens,
    };
    return run;
  }

  async completeSucceeded(input: Parameters<AgentRunRepository["completeSucceeded"]>[0]) {
    const run = this.records.get(input.runId);
    if (run?.status !== "running") {
      return null;
    }

    Object.assign(run, {
      failureReason: null,
      finishedAt: input.finishedAt,
      providerProcessRef: null,
      status: "succeeded",
    });
    run.usage.sandboxDurationMs = Math.max(run.usage.sandboxDurationMs, input.sandboxDurationMs);
    if (input.assistantMessage) {
      this.messages.records.push({
        agentRunId: run.id,
        content: input.assistantMessage.content,
        createdAt: input.finishedAt,
        id: input.assistantMessage.id,
        projectId: run.projectId,
        role: "assistant",
        sequence: this.messages.records.filter((message) => message.projectId === run.projectId)
          .length,
      });
    }
    return run;
  }

  async transition(input: Parameters<AgentRunRepository["transition"]>[0]) {
    if (!canTransitionAgentRun(input.from, input.to)) {
      throw new Error(`Invalid AgentRun transition from ${input.from} to ${input.to}`);
    }
    const run = this.records.get(input.runId);
    if (!run || run.status !== input.from) {
      return null;
    }

    Object.assign(run, {
      failureReason: input.failureReason ?? run.failureReason,
      finishedAt: input.finishedAt ?? run.finishedAt,
      startedAt: input.startedAt ?? run.startedAt,
      status: input.to,
    });
    return run;
  }
}

class FakeRunCoordinator implements RunExecutionDispatcher {
  readonly starts: StartAgentRunInput[] = [];

  constructor(private readonly agentRuns: InMemoryAgentRunRepository) {}

  async cancel(run: AgentRunRecord, now: Date) {
    if (isTerminalAgentRun(run.status) || run.status === "cancelling") {
      return run;
    }

    const targetStatus = run.status === "queued" ? "cancelled" : "cancelling";
    return this.agentRuns.transition({
      finishedAt: targetStatus === "cancelled" ? now.toISOString() : undefined,
      from: run.status,
      runId: run.id,
      to: targetStatus,
    });
  }

  async start(input: StartAgentRunInput) {
    this.starts.push(input);
    return { completion: new FakeCoordinatedAgentRun().completion };
  }
}

class FakeCoordinatedAgentRun implements CoordinatedAgentRun {
  readonly completion = new Promise<AgentRunRecord>(() => undefined);

  async cancel(): Promise<AgentRunRecord> {
    return this.completion;
  }
}

function emptyUsage(): AgentRunUsage {
  return {
    inputTokens: 0,
    modelRequestCount: 0,
    outputTokens: 0,
    sandboxDurationMs: 0,
    totalTokens: 0,
  };
}
