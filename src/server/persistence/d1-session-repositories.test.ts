import { describe, expect, it } from "vitest";

import { D1PreviewSessionRepository, D1TerminalSessionRepository } from "./d1-repositories";
import { TestD1Database, result } from "./d1-test-database";

describe("D1 Terminal and Preview repositories", () => {
  it("atomically claims one ephemeral Terminal against an unchanged Lease", async () => {
    const db = new TestD1Database();
    db.batchResults.push([
      result(),
      result([
        {
          created_at: "2026-07-25T00:30:00.000Z",
          expires_at: "2026-07-25T01:00:00.000Z",
          id: "terminal-new",
          project_id: "project-1",
          provider_process_ref: null,
          provider_sandbox_ref: null,
          sandbox_lease_id: "lease-1",
          updated_at: "2026-07-25T00:30:00.000Z",
        },
      ]),
    ]);

    const claimed = await new D1TerminalSessionRepository(db.asBinding()).claim({
      expectedLeaseProviderRef: "sandbox-1",
      expectedLeaseUpdatedAt: "2026-07-25T00:29:00.000Z",
      expiresAt: "2026-07-25T01:00:00.000Z",
      id: "terminal-new",
      now: "2026-07-25T00:30:00.000Z",
      projectId: "project-1",
      sandboxLeaseId: "lease-1",
    });

    expect(claimed).toMatchObject({
      kind: "claimed",
      session: {
        id: "terminal-new",
        providerProcessRef: null,
        providerSandboxRef: null,
      },
    });
    expect(db.batches[0]?.[0]?.query).toContain("NOT EXISTS");
    expect(db.batches[0]?.[0]?.query).toContain("sandbox_leases.updated_at = ?");
    expect(db.batches[0]?.[0]?.query).not.toContain("ON CONFLICT(project_id) DO UPDATE");
    expect(db.batches[0]?.[0]?.query).toContain("status = 'starting'");
  });

  it("returns project_busy when the atomic Terminal claim changes no row", async () => {
    const db = new TestD1Database();
    db.batchResults.push([result([], 0), result()]);

    await expect(
      new D1TerminalSessionRepository(db.asBinding()).claim({
        expectedLeaseProviderRef: null,
        expectedLeaseUpdatedAt: "2026-07-25T00:29:00.000Z",
        expiresAt: "2026-07-25T01:00:00.000Z",
        id: "terminal-new",
        now: "2026-07-25T00:30:00.000Z",
        projectId: "project-1",
        sandboxLeaseId: "lease-1",
      }),
    ).resolves.toEqual({ kind: "project_busy" });
  });

  it("releases a Terminal and marks its unchanged Lease idle in one batch", async () => {
    const db = new TestD1Database();
    db.batchResults.push([result(), result()]);

    const released = await new D1TerminalSessionRepository(db.asBinding()).releaseAndMarkLeaseIdle({
      expectedProviderSandboxRef: "sandbox-1",
      now: "2026-07-25T00:31:00.000Z",
      sessionId: "terminal-1",
    });

    expect(released).toBe(true);
    expect(db.batches[0]?.[0]?.query).toContain("SELECT sandbox_lease_id");
    expect(db.batches[0]?.[0]?.bindings).toEqual([
      "2026-07-25T00:31:00.000Z",
      "terminal-1",
      "sandbox-1",
      "sandbox-1",
    ]);
    expect(db.batches[0]?.[1]?.query).toContain("DELETE FROM terminal_sessions");
  });

  it("atomically claims and maps one fixed-port Preview session", async () => {
    const db = new TestD1Database();
    db.batchResults.push([
      result(),
      result([
        {
          created_at: "2026-07-25T00:30:00.000Z",
          expires_at: "2026-07-25T01:00:00.000Z",
          id: "preview-new",
          port: 3000,
          project_id: "project-1",
          provider_process_ref: null,
          provider_sandbox_ref: "sandbox-1",
          sandbox_lease_id: "lease-1",
          status: "starting",
          updated_at: "2026-07-25T00:30:00.000Z",
        },
      ]),
    ]);

    const claimed = await new D1PreviewSessionRepository(db.asBinding()).claim({
      expectedLeaseProviderRef: "sandbox-1",
      expectedLeaseUpdatedAt: "2026-07-25T00:29:00.000Z",
      expiresAt: "2026-07-25T01:00:00.000Z",
      id: "preview-new",
      now: "2026-07-25T00:30:00.000Z",
      port: 3000,
      projectId: "project-1",
      sandboxLeaseId: "lease-1",
    });

    expect(claimed).toEqual({
      kind: "claimed",
      session: {
        createdAt: "2026-07-25T00:30:00.000Z",
        expiresAt: "2026-07-25T01:00:00.000Z",
        id: "preview-new",
        port: 3000,
        projectId: "project-1",
        providerProcessRef: null,
        providerSandboxRef: "sandbox-1",
        sandboxLeaseId: "lease-1",
        status: "starting",
        updatedAt: "2026-07-25T00:30:00.000Z",
      },
    });
    expect(db.batches[0]?.[0]?.query).toContain("sandbox_leases.status IN ('idle', 'ready')");
    expect(db.batches[0]?.[0]?.query).toContain("FROM agent_runs");
    expect(db.batches[0]?.[0]?.query).toContain("FROM terminal_sessions");
  });

  it("clears a matching Preview row when Terminal fallback stops the whole sandbox", async () => {
    const db = new TestD1Database();
    db.batchResults.push([result([], 0), result(), result()]);

    const released = await new D1TerminalSessionRepository(
      db.asBinding(),
    ).releaseAndMarkLeaseStopped({
      expectedProviderSandboxRef: "sandbox-1",
      now: "2026-07-25T00:31:00.000Z",
      sessionId: "terminal-1",
    });

    expect(released).toBe(true);
    expect(db.batches[0]?.[0]?.query).toContain("DELETE FROM preview_sessions");
    expect(db.batches[0]?.[1]?.query).toContain("status = 'stopped'");
  });
});
