import { describe, expect, it, vi } from "vitest";

import type {
  AgentRunRecord,
  PreviewSessionRecord,
  PreviewSessionRepository,
  SandboxLeaseRecord,
} from "./ports";
import { ProjectPreviewService, projectPreviewPort } from "./project-preview";
import { SandboxUnavailableError, type SandboxPreviewRuntime } from "../runtime/contract";

const now = "2026-07-26T08:00:00.000Z";

describe("ProjectPreviewService", () => {
  it("starts only the fixed Preview preset and persists the private process reference", async () => {
    const harness = createHarness();

    const result = await harness.service.start("project-1");

    expect(result).toEqual({
      kind: "started",
      status: {
        expiresAt: "2026-07-26T08:30:00.000Z",
        issuedAt: now,
        kind: "running",
        sessionId: "preview-1",
      },
    });
    expect(harness.runtime.startPreview).toHaveBeenCalledWith(
      {
        id: "sandbox-1",
        kind: "e2b",
        sandboxLeaseId: "lease-1",
      },
      {
        contentBasePath: "/api/projects/project-1/preview/content/capability/",
        port: projectPreviewPort,
        preset: "vite-v1",
        processTimeoutMs: 1_815_000,
        startupTimeoutMs: 20_000,
      },
    );
    expect(harness.previewSessions.markRunning).toHaveBeenCalledWith(
      "preview-1",
      "process-42",
      now,
    );
    expect(harness.scheduleExpiry).toHaveBeenCalledWith({
      expiresAt: "2026-07-26T08:30:00.000Z",
      previewSessionId: "preview-1",
      projectId: "project-1",
    });
  });

  it("does not claim Preview during an AgentRun or without a live sandbox", async () => {
    const active = createHarness({ activeRun: true });
    const stopped = createHarness({ sandboxAvailable: false });

    await expect(active.service.start("project-1")).resolves.toEqual({
      kind: "project_busy",
    });
    await expect(stopped.service.start("project-1")).resolves.toEqual({
      kind: "sandbox_unavailable",
    });
    expect(active.previewSessions.claim).not.toHaveBeenCalled();
    expect(stopped.previewSessions.claim).not.toHaveBeenCalled();
  });

  it("releases the D1 claim when durable expiry cannot be scheduled", async () => {
    const harness = createHarness({ expiryError: true });

    await expect(harness.service.start("project-1")).resolves.toEqual({
      kind: "provider_error",
    });
    expect(harness.runtime.startPreview).not.toHaveBeenCalled();
    expect(harness.previewSessions.release).toHaveBeenCalledWith({
      expectedProviderSandboxRef: "sandbox-1",
      sessionId: "preview-1",
    });
  });

  it("releases the D1 claim when the signed content base cannot be created", async () => {
    const harness = createHarness({ contentBaseError: true });

    await expect(harness.service.start("project-1")).resolves.toEqual({
      kind: "provider_error",
    });
    expect(harness.runtime.startPreview).not.toHaveBeenCalled();
    expect(harness.previewSessions.release).toHaveBeenCalledWith({
      expectedProviderSandboxRef: "sandbox-1",
      sessionId: "preview-1",
    });
    expect(harness.reportFailure).toHaveBeenCalledWith({
      errorName: "Error",
      stage: "content_base",
    });
  });

  it("reconciles a naturally exited process and schedules idle cleanup", async () => {
    const harness = createHarness({
      existingStatus: "running",
      processRunning: false,
    });

    await expect(harness.service.inspect("project-1")).resolves.toEqual({
      expiresAt: null,
      kind: "stopped",
    });
    expect(harness.previewSessions.release).toHaveBeenCalled();
    expect(harness.scheduleIdleCleanup).toHaveBeenCalledWith({
      expectedLeaseUpdatedAt: now,
      previewSessionId: "preview-1",
      projectId: "project-1",
    });
  });

  it("stops only the Preview process and leaves the Project sandbox attached", async () => {
    const harness = createHarness({ existingStatus: "running" });

    await expect(harness.service.stop("project-1")).resolves.toEqual({
      kind: "stopped",
    });
    expect(harness.runtime.terminatePreview).toHaveBeenCalledWith(
      {
        id: "sandbox-1",
        kind: "e2b",
        sandboxLeaseId: "lease-1",
      },
      "process-42",
      "client_stopped",
    );
    expect(harness.scheduleIdleCleanup).toHaveBeenCalled();
  });

  it("fetches content only through the recorded session and sandbox", async () => {
    const harness = createHarness({ existingStatus: "running" });
    const request = {
      headers: { accept: "text/html" },
      method: "GET" as const,
      pathAndQuery: "/?view=home",
    };

    const result = await harness.service.fetch("project-1", "preview-1", request);

    expect(result.kind).toBe("ok");
    expect(harness.runtime.fetchPreview).toHaveBeenCalledWith(
      {
        id: "sandbox-1",
        kind: "e2b",
        sandboxLeaseId: "lease-1",
      },
      3000,
      request,
    );
  });

  it("releases Preview ownership when content detects an expired sandbox", async () => {
    const harness = createHarness({
      existingStatus: "running",
      sandboxGone: true,
    });

    await expect(
      harness.service.fetch("project-1", "preview-1", {
        headers: {},
        method: "GET",
        pathAndQuery: "/",
      }),
    ).resolves.toEqual({ kind: "sandbox_unavailable" });
    expect(harness.previewSessions.release).toHaveBeenCalled();
    expect(harness.scheduleIdleCleanup).toHaveBeenCalled();
  });

  it("maps runtime factory failures without leaking them through HTTP use cases", async () => {
    const harness = createHarness({
      existingStatus: "running",
      runtimeFactoryError: true,
    });

    await expect(harness.service.stop("project-1")).resolves.toEqual({
      kind: "provider_error",
    });
    await expect(
      harness.service.fetch("project-1", "preview-1", {
        headers: {},
        method: "GET",
        pathAndQuery: "/",
      }),
    ).resolves.toEqual({ kind: "provider_error" });
  });
});

function createHarness(
  options: {
    activeRun?: boolean;
    contentBaseError?: boolean;
    existingStatus?: PreviewSessionRecord["status"];
    expiryError?: boolean;
    processRunning?: boolean;
    runtimeFactoryError?: boolean;
    sandboxAvailable?: boolean;
    sandboxGone?: boolean;
  } = {},
) {
  const lease: SandboxLeaseRecord = {
    createdAt: now,
    id: "lease-1",
    projectId: "project-1",
    providerRef: options.sandboxAvailable === false ? null : "sandbox-1",
    runtimeId: "e2b",
    status: options.sandboxAvailable === false ? "stopped" : "idle",
    updatedAt: now,
  };
  let session: PreviewSessionRecord | null =
    options.existingStatus === undefined ? null : createPreviewRecord(options.existingStatus);
  const previewSessions = {
    claim: vi.fn(async () => {
      session = createPreviewRecord("starting");
      return { kind: "claimed" as const, session };
    }),
    findById: vi.fn(async () => session),
    findByProjectId: vi.fn(async () => session),
    markRunning: vi.fn(async () => {
      session = createPreviewRecord("running");
      return session;
    }),
    release: vi.fn(async () => {
      session = null;
      return true;
    }),
  } satisfies PreviewSessionRepository;
  const runtime = {
    fetchPreview: vi.fn(async () => {
      if (options.sandboxGone) {
        throw new SandboxUnavailableError();
      }
      return new Response("<h1>Preview</h1>", {
        headers: { "content-type": "text/html" },
      });
    }),
    isPreviewRunning: vi.fn(async () => options.processRunning !== false),
    kind: "e2b",
    startPreview: vi.fn(async () => ({
      providerProcessRef: "process-42",
    })),
    terminatePreview: vi.fn(async () => undefined),
  } satisfies SandboxPreviewRuntime;
  const scheduleExpiry = vi.fn(async () => {
    if (options.expiryError) {
      throw new Error("Workflow unavailable");
    }
  });
  const scheduleIdleCleanup = vi.fn(async () => undefined);
  const reportFailure = vi.fn();
  const service = new ProjectPreviewService({
    agentRuns: {
      findActiveByProjectId: vi.fn(async () => (options.activeRun ? ({} as AgentRunRecord) : null)),
    },
    clock: { now: () => new Date(now) },
    createContentBasePath: vi.fn(async () => {
      if (options.contentBaseError) {
        throw new Error("Signing unavailable");
      }
      return "/api/projects/project-1/preview/content/capability/";
    }),
    createId: () => "preview-1",
    getSandboxRuntime: () => {
      if (options.runtimeFactoryError) {
        throw new Error("Provider unavailable");
      }
      return runtime;
    },
    previewSessions,
    reportFailure,
    sandboxLeases: {
      findByProjectId: vi.fn(async () => lease),
    },
    sandboxRuntimeId: "e2b",
    scheduleExpiry,
    scheduleIdleCleanup,
    terminalSessions: {
      findByProjectId: vi.fn(async () => null),
    },
  });

  return {
    previewSessions,
    reportFailure,
    runtime,
    scheduleExpiry,
    scheduleIdleCleanup,
    service,
  };
}

function createPreviewRecord(status: PreviewSessionRecord["status"]): PreviewSessionRecord {
  return {
    createdAt: now,
    expiresAt: "2026-07-26T08:30:00.000Z",
    id: "preview-1",
    port: 3000,
    projectId: "project-1",
    providerProcessRef: status === "running" ? "process-42" : null,
    providerSandboxRef: "sandbox-1",
    sandboxLeaseId: "lease-1",
    status,
    updatedAt: now,
  };
}
