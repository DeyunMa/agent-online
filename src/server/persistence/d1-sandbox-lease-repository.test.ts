import { describe, expect, it } from "vitest";

import { D1SandboxLeaseRepository } from "./d1-repositories";
import { TestD1Database, result } from "./d1-test-database";

describe("D1 SandboxLease repository", () => {
  it("loads Project leases in bounded batch queries", async () => {
    const db = new TestD1Database();
    db.batchResults.push([
      result([
        {
          created_at: "2026-07-25T00:00:00.000Z",
          id: "lease-1",
          project_id: "project-1",
          provider_ref: null,
          sandbox_runtime_id: "e2b",
          status: "stopped",
          updated_at: "2026-07-25T00:00:00.000Z",
        },
      ]),
      result(),
    ]);
    const projectIds = Array.from({ length: 91 }, (_, index) => `project-${index + 1}`);

    const leases = await new D1SandboxLeaseRepository(db.asBinding()).findByProjectIds(projectIds);

    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toHaveLength(2);
    expect(db.batches[0]?.[0]?.bindings).toHaveLength(90);
    expect(db.batches[0]?.[1]?.bindings).toEqual(["project-91"]);
    expect(leases).toMatchObject([{ id: "lease-1", projectId: "project-1" }]);
  });

  it("gets or creates one logical sandbox lease in one batch", async () => {
    const db = new TestD1Database();
    db.batchResults.push([
      result(),
      result([
        {
          created_at: "2026-07-25T00:00:00.000Z",
          id: "lease-1",
          project_id: "project-1",
          provider_ref: null,
          sandbox_runtime_id: "fake",
          status: "stopped",
          updated_at: "2026-07-25T00:00:00.000Z",
        },
      ]),
    ]);

    const lease = await new D1SandboxLeaseRepository(db.asBinding()).getOrCreate({
      id: "lease-1",
      now: "2026-07-25T00:00:00.000Z",
      projectId: "project-1",
      runtimeId: "fake",
    });

    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toHaveLength(2);
    expect(db.batches[0]?.[0]?.query).toContain("ON CONFLICT(project_id) DO NOTHING");
    expect(lease).toMatchObject({ id: "lease-1", projectId: "project-1", runtimeId: "fake" });
  });

  it("atomically claims only the latest Run's unchanged idle sandbox", async () => {
    const db = new TestD1Database();

    const claimed = await new D1SandboxLeaseRepository(db.asBinding()).claimIdleForStop({
      expectedProviderRef: "sandbox-1",
      expectedRunId: "run-2",
      expectedUpdatedAt: "2026-07-25T00:03:00.000Z",
      leaseId: "lease-1",
      updatedAt: "2026-07-25T00:13:00.000Z",
    });

    expect(claimed).toBe(true);
    expect(db.prepared[0]?.query).toContain("SET provider_ref = NULL, status = 'stopped'");
    expect(db.prepared[0]?.query).toContain("ORDER BY created_at DESC, id DESC");
    expect(db.prepared[0]?.query).toContain(
      "status IN ('queued', 'starting', 'running', 'cancelling')",
    );
    expect(db.prepared[0]?.query).toContain("FROM terminal_sessions");
    expect(db.prepared[0]?.query).toContain("FROM preview_sessions");
    expect(db.prepared[0]?.bindings).toEqual([
      "2026-07-25T00:13:00.000Z",
      "lease-1",
      "sandbox-1",
      "2026-07-25T00:03:00.000Z",
      "run-2",
    ]);
  });

  it("atomically claims an unchanged idle sandbox after Terminal activity", async () => {
    const db = new TestD1Database();

    const claimed = await new D1SandboxLeaseRepository(
      db.asBinding(),
    ).claimIdleAfterActivityForStop({
      expectedProviderRef: "sandbox-1",
      expectedUpdatedAt: "2026-07-25T00:03:00.000Z",
      leaseId: "lease-1",
      updatedAt: "2026-07-25T00:13:00.000Z",
    });

    expect(claimed).toBe(true);
    expect(db.prepared[0]?.query).not.toContain("ORDER BY created_at");
    expect(db.prepared[0]?.query).toContain("FROM terminal_sessions");
    expect(db.prepared[0]?.query).toContain("FROM preview_sessions");
    expect(db.prepared[0]?.bindings).toEqual([
      "2026-07-25T00:13:00.000Z",
      "lease-1",
      "sandbox-1",
      "2026-07-25T00:03:00.000Z",
    ]);
  });

  it("atomically claims a manual stop only when the Project has no active Run", async () => {
    const db = new TestD1Database();

    const claimed = await new D1SandboxLeaseRepository(db.asBinding()).claimForManualStop({
      expectedProviderRef: "provider-private-sandbox",
      expectedUpdatedAt: "2026-07-25T00:03:00.000Z",
      leaseId: "lease-1",
      updatedAt: "2026-07-25T00:04:00.000Z",
    });

    expect(claimed).toBe(true);
    expect(db.prepared[0]?.query).toContain("SET provider_ref = NULL, status = 'stopped'");
    expect(db.prepared[0]?.query).toContain(
      "status IN ('queued', 'starting', 'running', 'cancelling')",
    );
    expect(db.prepared[0]?.query).toContain("FROM terminal_sessions");
    expect(db.prepared[0]?.query).toContain("FROM preview_sessions");
    expect(db.prepared[0]?.bindings).toEqual([
      "2026-07-25T00:04:00.000Z",
      "lease-1",
      "provider-private-sandbox",
      "2026-07-25T00:03:00.000Z",
    ]);
  });

  it("clears stale Preview ownership when a whole-sandbox failure marks the Lease stopped", async () => {
    const db = new TestD1Database();
    db.batchResults.push([
      result(),
      result([], 0),
      result([
        {
          created_at: "2026-07-25T00:00:00.000Z",
          id: "lease-1",
          project_id: "project-1",
          provider_ref: null,
          sandbox_runtime_id: "e2b",
          status: "stopped",
          updated_at: "2026-07-25T00:04:00.000Z",
        },
      ]),
    ]);

    const lease = await new D1SandboxLeaseRepository(db.asBinding()).updateState({
      leaseId: "lease-1",
      providerRef: null,
      status: "stopped",
      updatedAt: "2026-07-25T00:04:00.000Z",
    });

    expect(lease).toMatchObject({
      id: "lease-1",
      providerRef: null,
      status: "stopped",
    });
    expect(db.batches[0]?.[1]?.query).toContain("DELETE FROM preview_sessions");
    expect(db.batches[0]?.[1]?.bindings).toEqual(["lease-1"]);
  });
});
