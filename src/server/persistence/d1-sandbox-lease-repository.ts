import type { SandboxLeaseRecord, SandboxLeaseRepository } from "../../application/ports";
import type { SandboxLeaseStatus } from "../../domain/sandbox-lease";
import type { RuntimeKind } from "../../runtime/contract";
import {
  type SandboxLeaseRow,
  requireBatchRow,
  sandboxLeaseColumns,
  toSandboxLeaseRecord,
} from "./d1-records";

export class D1SandboxLeaseRepository implements SandboxLeaseRepository {
  constructor(private readonly db: D1Database) {}

  async claimIdleAfterActivityForStop(input: {
    expectedProviderRef: string;
    expectedUpdatedAt: string;
    leaseId: string;
    updatedAt: string;
  }) {
    const result = await this.db
      .prepare(
        `UPDATE sandbox_leases
        SET provider_ref = NULL, status = 'stopped', updated_at = ?
        WHERE id = ?
          AND provider_ref = ?
          AND status = 'idle'
          AND updated_at = ?
          AND NOT EXISTS (
            SELECT 1
            FROM agent_runs
            WHERE project_id = sandbox_leases.project_id
              AND status IN ('queued', 'starting', 'running', 'cancelling')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM terminal_sessions
            WHERE project_id = sandbox_leases.project_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM preview_sessions
            WHERE project_id = sandbox_leases.project_id
          )`,
      )
      .bind(input.updatedAt, input.leaseId, input.expectedProviderRef, input.expectedUpdatedAt)
      .run();

    return result.meta.changes === 1;
  }

  async claimForManualStop(input: {
    expectedProviderRef: string;
    expectedUpdatedAt: string;
    leaseId: string;
    updatedAt: string;
  }) {
    const result = await this.db
      .prepare(
        `UPDATE sandbox_leases
        SET provider_ref = NULL, status = 'stopped', updated_at = ?
        WHERE id = ?
          AND provider_ref = ?
          AND status != 'stopped'
          AND updated_at = ?
          AND NOT EXISTS (
            SELECT 1
            FROM agent_runs
            WHERE project_id = sandbox_leases.project_id
              AND status IN ('queued', 'starting', 'running', 'cancelling')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM terminal_sessions
            WHERE project_id = sandbox_leases.project_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM preview_sessions
            WHERE project_id = sandbox_leases.project_id
          )`,
      )
      .bind(input.updatedAt, input.leaseId, input.expectedProviderRef, input.expectedUpdatedAt)
      .run();

    return result.meta.changes === 1;
  }

  async claimIdleForStop(input: {
    expectedProviderRef: string;
    expectedRunId: string;
    expectedUpdatedAt: string;
    leaseId: string;
    updatedAt: string;
  }) {
    const result = await this.db
      .prepare(
        `UPDATE sandbox_leases
        SET provider_ref = NULL, status = 'stopped', updated_at = ?
        WHERE id = ?
          AND provider_ref = ?
          AND status = 'idle'
          AND updated_at = ?
          AND (
            SELECT id
            FROM agent_runs
            WHERE project_id = sandbox_leases.project_id
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          ) = ?
          AND NOT EXISTS (
            SELECT 1
            FROM agent_runs
            WHERE project_id = sandbox_leases.project_id
              AND status IN ('queued', 'starting', 'running', 'cancelling')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM terminal_sessions
            WHERE project_id = sandbox_leases.project_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM preview_sessions
            WHERE project_id = sandbox_leases.project_id
          )`,
      )
      .bind(
        input.updatedAt,
        input.leaseId,
        input.expectedProviderRef,
        input.expectedUpdatedAt,
        input.expectedRunId,
      )
      .run();

    return result.meta.changes === 1;
  }

  async findByProjectId(projectId: string): Promise<SandboxLeaseRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${sandboxLeaseColumns} FROM sandbox_leases WHERE project_id = ? LIMIT 1`)
      .bind(projectId)
      .first<SandboxLeaseRow>();

    return row === null ? null : toSandboxLeaseRecord(row);
  }

  async getOrCreate(input: {
    id: string;
    now: string;
    projectId: string;
    runtimeId: RuntimeKind;
  }): Promise<SandboxLeaseRecord> {
    const results = await this.db.batch<SandboxLeaseRow>([
      this.db
        .prepare(
          `INSERT INTO sandbox_leases (
            id,
            project_id,
            sandbox_runtime_id,
            provider_ref,
            status,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, NULL, 'stopped', ?, ?)
          ON CONFLICT(project_id) DO NOTHING`,
        )
        .bind(input.id, input.projectId, input.runtimeId, input.now, input.now),
      this.db
        .prepare(`SELECT ${sandboxLeaseColumns} FROM sandbox_leases WHERE project_id = ? LIMIT 1`)
        .bind(input.projectId),
    ]);

    return toSandboxLeaseRecord(
      requireBatchRow<SandboxLeaseRow>(results, 1, "getOrCreate sandbox lease"),
    );
  }

  async updateState(input: {
    providerRef: string | null;
    status: SandboxLeaseStatus;
    updatedAt: string;
    leaseId: string;
  }): Promise<SandboxLeaseRecord> {
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE sandbox_leases
          SET provider_ref = ?, status = ?, updated_at = ?
          WHERE id = ?`,
        )
        .bind(input.providerRef, input.status, input.updatedAt, input.leaseId),
    ];
    if (input.status === "stopped" || input.providerRef === null) {
      statements.push(
        this.db
          .prepare(
            `DELETE FROM preview_sessions
            WHERE sandbox_lease_id = ?`,
          )
          .bind(input.leaseId),
      );
    }
    statements.push(
      this.db
        .prepare(
          `SELECT ${sandboxLeaseColumns}
          FROM sandbox_leases
          WHERE id = ?
          LIMIT 1`,
        )
        .bind(input.leaseId),
    );
    const results = await this.db.batch<SandboxLeaseRow>(statements);

    if (results[0]?.meta.changes !== 1) {
      throw new Error(`Sandbox lease not found: ${input.leaseId}`);
    }

    return toSandboxLeaseRecord(
      requireBatchRow<SandboxLeaseRow>(results, results.length - 1, "update sandbox lease"),
    );
  }
}
