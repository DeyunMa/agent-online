import { Hono } from "hono";
import { describe, expect, it } from "vitest";

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
} from "../application/ports";
import type { CoordinatedAgentRun, StartAgentRunInput } from "../application/run-coordinator";
import { isTerminalAgentRun } from "../domain/agent-run";
import type { AgentRunResponse, MessageResponse, ProjectResponse } from "../shared/api";
import type { AppEnv } from "./env";
import { createProjectApi } from "./project-api";
import type { ServerServices } from "./services";

const testUser = { email: "user@example.test", id: "user_1" };
const otherUser = { email: "other@example.test", id: "user_2" };
const now = "2026-07-25T00:00:00.000Z";

describe("Project API", () => {
  it("rejects an unauthenticated request before accessing product data", async () => {
    const fixture = createFixture(null);

    const response = await fixture.app.request("http://agent-online.test/api/projects");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized", requestId: "test-request" });
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
    const inaccessible = await fixture.app.request("http://agent-online.test/api/projects/project_other/messages");

    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: "validation_error" });
    expect(inaccessible.status).toBe(404);
    await expect(inaccessible.json()).resolves.toMatchObject({ error: "not_found" });
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

    const createdResponse = await fixture.app.request("http://agent-online.test/api/projects/project_1/agent-runs", {
      body: JSON.stringify({ content: "  Build a demo  " }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const created = (await createdResponse.json()) as AgentRunResponse;
    const messagesResponse = await fixture.app.request("http://agent-online.test/api/projects/project_1/messages");
    const messages = (await messagesResponse.json()) as MessageResponse[];
    const activeResponse = await fixture.app.request("http://agent-online.test/api/projects/project_1/agent-runs/active");
    const active = (await activeResponse.json()) as AgentRunResponse;
    const secondResponse = await fixture.app.request("http://agent-online.test/api/projects/project_1/agent-runs", {
      body: JSON.stringify({ content: "Try a second Run" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(createdResponse.status).toBe(201);
    expect(created).toMatchObject({ agentRuntimeId: "pi", sandboxRuntimeId: "fake", status: "queued" });
    expect(JSON.stringify(created)).not.toContain("providerRef");
    expect(fixture.coordinator.starts).toHaveLength(1);
    expect(fixture.coordinator.starts[0]).toMatchObject({ prompt: "Build a demo", workingDirectory: "/workspace" });
    expect(messages).toMatchObject([{ content: "Build a demo", role: "user", sequence: 0 }]);
    expect(activeResponse.status).toBe(200);
    expect(active).toMatchObject({ id: created.id, status: "queued" });
    expect(secondResponse.status).toBe(409);
    await expect(secondResponse.json()).resolves.toMatchObject({ error: "project_busy" });
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

    const createdResponse = await fixture.app.request("http://agent-online.test/api/projects/project_1/agent-runs", {
      body: JSON.stringify({ content: "Build a demo" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
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
});

function createFixture(user: typeof testUser | null) {
  const projects = new InMemoryProjectRepository();
  const messages = new InMemoryMessageRepository();
  const agentRuns = new InMemoryAgentRunRepository(messages);
  const sandboxLeases = new InMemorySandboxLeaseRepository();
  const coordinator = new FakeRunCoordinator();
  const services: ServerServices = {
    agentRuns,
    messages,
    projects,
    runCoordinator: coordinator,
    sandboxLeases,
  };
  let id = 0;
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("requestId", "test-request");
    await next();
  });
  app.route(
    "/api",
    createProjectApi({
      createId: () => `id_${++id}`,
      createServices: () => services,
      getAuthenticatedUser: async () => user,
      now: () => new Date(now),
    }),
  );

  return { agentRuns, app, coordinator, messages, projects, sandboxLeases };
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

  async deleteOwned(projectId: string, userId: string) {
    const project = await this.findOwnedById(projectId, userId);
    return project ? this.records.delete(project.id) : false;
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

  async listByProjectId(projectId: string) {
    return this.records
      .filter((message) => message.projectId === projectId)
      .sort((left, right) => left.sequence - right.sequence);
  }
}

class InMemorySandboxLeaseRepository implements SandboxLeaseRepository {
  readonly records = new Map<string, SandboxLeaseRecord>();

  async findByProjectId(projectId: string) {
    return [...this.records.values()].find((lease) => lease.projectId === projectId) ?? null;
  }

  async getOrCreate(input: { id: string; now: string; projectId: string; runtimeId: "fake" | "e2b" | "cloudflare-container" }) {
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

  async updateState(input: { leaseId: string; providerRef: string | null; status: SandboxLeaseRecord["status"]; updatedAt: string }) {
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

  async createQueuedWithInput(input: Parameters<AgentRunRepository["createQueuedWithInput"]>[0]): Promise<CreateQueuedAgentRunResult> {
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
      sequence: this.messages.records.filter((message) => message.projectId === input.projectId).length,
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

  async findActiveOwnedByProjectId(projectId: string, userId: string) {
    return (
      [...this.records.values()].find(
        (run) => run.projectId === projectId && run.userId === userId && !isTerminalAgentRun(run.status),
      ) ?? null
    );
  }

  async findOwnedById(agentRunId: string, userId: string) {
    const run = this.records.get(agentRunId);
    return run?.userId === userId ? run : null;
  }

  async transition(input: Parameters<AgentRunRepository["transition"]>[0]) {
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

  async updateUsage(runId: string, usage: AgentRunUsage) {
    const run = this.records.get(runId);
    if (!run) {
      return null;
    }

    run.usage = usage;
    return run;
  }
}

class FakeRunCoordinator {
  readonly starts: StartAgentRunInput[] = [];

  async start(input: StartAgentRunInput): Promise<CoordinatedAgentRun> {
    this.starts.push(input);
    return new FakeCoordinatedAgentRun();
  }
}

class FakeCoordinatedAgentRun implements CoordinatedAgentRun {
  readonly completion = new Promise<AgentRunRecord>(() => undefined);
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
