import type { TerminalSessionRepository } from "../../application/ports";
import {
  type TerminalSessionRow,
  requireBatchRow,
  terminalSessionColumns,
  toTerminalSessionRecord,
} from "./d1-records";

export class D1TerminalSessionRepository implements TerminalSessionRepository {
  constructor(private readonly db: D1Database) {}

  async claim(input: {
    expectedLeaseProviderRef: string | null;
    expectedLeaseUpdatedAt: string;
    expiresAt: string;
    id: string;
    now: string;
    projectId: string;
    sandboxLeaseId: string;
  }) {
    const results = await this.db.batch<TerminalSessionRow>([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO terminal_sessions (
            id,
            project_id,
            sandbox_lease_id,
            provider_sandbox_ref,
            provider_process_ref,
            expires_at,
            created_at,
            updated_at
          )
          SELECT ?, ?, sandbox_leases.id, NULL, NULL, ?, ?, ?
          FROM sandbox_leases
          WHERE sandbox_leases.id = ?
            AND sandbox_leases.project_id = ?
            AND sandbox_leases.updated_at = ?
            AND sandbox_leases.provider_ref IS ?
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
                AND status = 'starting'
            )`,
        )
        .bind(
          input.id,
          input.projectId,
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
          `SELECT ${terminalSessionColumns}
          FROM terminal_sessions
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
      session: toTerminalSessionRecord(
        requireBatchRow<TerminalSessionRow>(results, 1, "claim Terminal session"),
      ),
    };
  }

  async findById(sessionId: string) {
    const row = await this.db
      .prepare(
        `SELECT ${terminalSessionColumns}
        FROM terminal_sessions
        WHERE id = ?
        LIMIT 1`,
      )
      .bind(sessionId)
      .first<TerminalSessionRow>();

    return row === null ? null : toTerminalSessionRecord(row);
  }

  async findByProjectId(projectId: string) {
    const row = await this.db
      .prepare(
        `SELECT ${terminalSessionColumns}
        FROM terminal_sessions
        WHERE project_id = ?
        LIMIT 1`,
      )
      .bind(projectId)
      .first<TerminalSessionRow>();

    return row === null ? null : toTerminalSessionRecord(row);
  }

  async setProviderProcessRef(sessionId: string, providerProcessRef: string, now: string) {
    if (!providerProcessRef || providerProcessRef.length > 512) {
      throw new Error("Terminal provider process reference is invalid");
    }

    const results = await this.db.batch<TerminalSessionRow>([
      this.db
        .prepare(
          `UPDATE terminal_sessions
          SET provider_process_ref = ?, updated_at = ?
          WHERE id = ?
            AND provider_sandbox_ref IS NOT NULL
            AND provider_process_ref IS NULL
          `,
        )
        .bind(providerProcessRef, now, sessionId),
      this.db
        .prepare(
          `SELECT ${terminalSessionColumns}
          FROM terminal_sessions
          WHERE id = ?
          LIMIT 1`,
        )
        .bind(sessionId),
    ]);

    if (results[0]?.meta.changes !== 1) {
      return null;
    }

    return toTerminalSessionRecord(
      requireBatchRow<TerminalSessionRow>(results, 1, "set Terminal process reference"),
    );
  }

  async setProviderSandboxRef(sessionId: string, providerSandboxRef: string, now: string) {
    if (!providerSandboxRef || providerSandboxRef.length > 512) {
      throw new Error("Terminal provider sandbox reference is invalid");
    }

    const results = await this.db.batch<TerminalSessionRow>([
      this.db
        .prepare(
          `UPDATE terminal_sessions
          SET provider_sandbox_ref = ?, updated_at = ?
          WHERE id = ?
            AND provider_sandbox_ref IS NULL`,
        )
        .bind(providerSandboxRef, now, sessionId),
      this.db
        .prepare(
          `SELECT ${terminalSessionColumns}
          FROM terminal_sessions
          WHERE id = ?
          LIMIT 1`,
        )
        .bind(sessionId),
    ]);

    if (results[0]?.meta.changes !== 1) {
      return null;
    }

    return toTerminalSessionRecord(
      requireBatchRow<TerminalSessionRow>(results, 1, "set Terminal sandbox reference"),
    );
  }

  async release(sessionId: string) {
    const result = await this.db
      .prepare("DELETE FROM terminal_sessions WHERE id = ?")
      .bind(sessionId)
      .run();

    return result.meta.changes === 1;
  }

  async releaseAndMarkLeaseIdle(input: {
    expectedProviderSandboxRef: string;
    now: string;
    sessionId: string;
  }) {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE sandbox_leases
          SET status = 'idle', updated_at = ?
          WHERE id = (
            SELECT sandbox_lease_id
            FROM terminal_sessions
            WHERE id = ?
              AND provider_sandbox_ref = ?
          )
            AND provider_ref = ?`,
        )
        .bind(
          input.now,
          input.sessionId,
          input.expectedProviderSandboxRef,
          input.expectedProviderSandboxRef,
        ),
      this.db
        .prepare(
          `DELETE FROM terminal_sessions
          WHERE id = ?
            AND provider_sandbox_ref = ?
            AND EXISTS (
              SELECT 1
              FROM sandbox_leases
              WHERE sandbox_leases.id = terminal_sessions.sandbox_lease_id
                AND sandbox_leases.provider_ref = ?
                AND sandbox_leases.status = 'idle'
                AND sandbox_leases.updated_at = ?
            )`,
        )
        .bind(
          input.sessionId,
          input.expectedProviderSandboxRef,
          input.expectedProviderSandboxRef,
          input.now,
        ),
    ]);

    return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1;
  }

  async releaseAndMarkLeaseStopped(input: {
    expectedProviderSandboxRef: string;
    now: string;
    sessionId: string;
  }) {
    const results = await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM preview_sessions
          WHERE sandbox_lease_id = (
            SELECT sandbox_lease_id
            FROM terminal_sessions
            WHERE id = ?
              AND provider_sandbox_ref = ?
          )
            AND provider_sandbox_ref = ?`,
        )
        .bind(input.sessionId, input.expectedProviderSandboxRef, input.expectedProviderSandboxRef),
      this.db
        .prepare(
          `UPDATE sandbox_leases
          SET provider_ref = NULL, status = 'stopped', updated_at = ?
          WHERE id = (
            SELECT sandbox_lease_id
            FROM terminal_sessions
            WHERE id = ?
              AND provider_sandbox_ref = ?
          )
            AND provider_ref = ?`,
        )
        .bind(
          input.now,
          input.sessionId,
          input.expectedProviderSandboxRef,
          input.expectedProviderSandboxRef,
        ),
      this.db
        .prepare(
          `DELETE FROM terminal_sessions
          WHERE id = ?
            AND provider_sandbox_ref = ?
            AND EXISTS (
              SELECT 1
              FROM sandbox_leases
              WHERE sandbox_leases.id = terminal_sessions.sandbox_lease_id
                AND sandbox_leases.provider_ref IS NULL
                AND sandbox_leases.status = 'stopped'
                AND sandbox_leases.updated_at = ?
            )`,
        )
        .bind(input.sessionId, input.expectedProviderSandboxRef, input.now),
    ]);

    return results[1]?.meta.changes === 1 && results[2]?.meta.changes === 1;
  }

  async markLeaseFailedKeepingSession(input: {
    expectedProviderSandboxRef: string;
    now: string;
    sessionId: string;
  }) {
    const result = await this.db
      .prepare(
        `UPDATE sandbox_leases
        SET status = 'failed', updated_at = ?
        WHERE id = (
          SELECT sandbox_lease_id
          FROM terminal_sessions
          WHERE id = ?
            AND provider_sandbox_ref = ?
        )
          AND provider_ref = ?`,
      )
      .bind(
        input.now,
        input.sessionId,
        input.expectedProviderSandboxRef,
        input.expectedProviderSandboxRef,
      )
      .run();

    return result.meta.changes === 1;
  }
}
