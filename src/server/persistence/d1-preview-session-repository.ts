import type { PreviewSessionRepository } from "../../application/ports";
import {
  type PreviewSessionRow,
  previewSessionColumns,
  requireBatchRow,
  toPreviewSessionRecord,
} from "./d1-records";

export class D1PreviewSessionRepository implements PreviewSessionRepository {
  constructor(private readonly db: D1Database) {}

  async claim(input: {
    expectedLeaseProviderRef: string;
    expectedLeaseUpdatedAt: string;
    expiresAt: string;
    id: string;
    now: string;
    port: number;
    projectId: string;
    sandboxLeaseId: string;
  }) {
    const results = await this.db.batch<PreviewSessionRow>([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO preview_sessions (
            id,
            project_id,
            sandbox_lease_id,
            provider_sandbox_ref,
            provider_process_ref,
            status,
            port,
            expires_at,
            created_at,
            updated_at
          )
          SELECT ?, ?, sandbox_leases.id, sandbox_leases.provider_ref, NULL,
            'starting', ?, ?, ?, ?
          FROM sandbox_leases
          WHERE sandbox_leases.id = ?
            AND sandbox_leases.project_id = ?
            AND sandbox_leases.updated_at = ?
            AND sandbox_leases.provider_ref = ?
            AND sandbox_leases.status IN ('idle', 'ready')
            AND NOT EXISTS (
              SELECT 1
              FROM agent_runs
              WHERE project_id = ?
                AND status IN ('queued', 'starting', 'running', 'cancelling')
            )
            AND NOT EXISTS (
              SELECT 1
              FROM terminal_sessions
              WHERE project_id = ?
            )
            AND NOT EXISTS (
              SELECT 1
              FROM preview_sessions
              WHERE project_id = ?
            )`,
        )
        .bind(
          input.id,
          input.projectId,
          input.port,
          input.expiresAt,
          input.now,
          input.now,
          input.sandboxLeaseId,
          input.projectId,
          input.expectedLeaseUpdatedAt,
          input.expectedLeaseProviderRef,
          input.projectId,
          input.projectId,
          input.projectId,
        ),
      this.db
        .prepare(
          `SELECT ${previewSessionColumns}
          FROM preview_sessions
          WHERE id = ?
          LIMIT 1`,
        )
        .bind(input.id),
    ]);

    if (results[0]?.meta.changes !== 1) {
      return { kind: "project_busy" } as const;
    }

    return {
      kind: "claimed" as const,
      session: toPreviewSessionRecord(
        requireBatchRow<PreviewSessionRow>(results, 1, "claim Preview session"),
      ),
    };
  }

  async findById(sessionId: string) {
    const row = await this.db
      .prepare(
        `SELECT ${previewSessionColumns}
        FROM preview_sessions
        WHERE id = ?
        LIMIT 1`,
      )
      .bind(sessionId)
      .first<PreviewSessionRow>();

    return row === null ? null : toPreviewSessionRecord(row);
  }

  async findByProjectId(projectId: string) {
    const row = await this.db
      .prepare(
        `SELECT ${previewSessionColumns}
        FROM preview_sessions
        WHERE project_id = ?
        LIMIT 1`,
      )
      .bind(projectId)
      .first<PreviewSessionRow>();

    return row === null ? null : toPreviewSessionRecord(row);
  }

  async markRunning(sessionId: string, providerProcessRef: string, now: string) {
    if (!providerProcessRef || providerProcessRef.length > 512) {
      throw new Error("Preview provider process reference is invalid");
    }

    const results = await this.db.batch<PreviewSessionRow>([
      this.db
        .prepare(
          `UPDATE preview_sessions
          SET provider_process_ref = ?, status = 'running', updated_at = ?
          WHERE id = ?
            AND status = 'starting'
            AND provider_process_ref IS NULL`,
        )
        .bind(providerProcessRef, now, sessionId),
      this.db
        .prepare(
          `SELECT ${previewSessionColumns}
          FROM preview_sessions
          WHERE id = ?
          LIMIT 1`,
        )
        .bind(sessionId),
    ]);

    if (results[0]?.meta.changes !== 1) {
      return null;
    }

    return toPreviewSessionRecord(
      requireBatchRow<PreviewSessionRow>(results, 1, "mark Preview running"),
    );
  }

  async release(input: { expectedProviderSandboxRef: string; sessionId: string }) {
    const result = await this.db
      .prepare(
        `DELETE FROM preview_sessions
        WHERE id = ?
          AND provider_sandbox_ref = ?`,
      )
      .bind(input.sessionId, input.expectedProviderSandboxRef)
      .run();

    return result.meta.changes === 1;
  }
}
