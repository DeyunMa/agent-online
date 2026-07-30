import type {
  MessageRecord,
  MessageRepository,
  ProjectRecord,
  ProjectRepository,
} from "../../application/ports";
import {
  type MessageRow,
  type ProjectRow,
  messageColumns,
  projectColumns,
  toMessageRecord,
  toProjectRecord,
} from "./d1-records";

export class D1ProjectRepository implements ProjectRepository {
  constructor(private readonly db: D1Database) {}

  async create(
    input: Omit<ProjectRecord, "createdAt" | "updatedAt"> & { now: string },
  ): Promise<ProjectRecord> {
    await this.db
      .prepare(
        `INSERT INTO projects (
          id,
          user_id,
          title,
          default_agent_runtime_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(input.id, input.userId, input.title, input.defaultAgentRuntimeId, input.now, input.now)
      .run();

    return {
      createdAt: input.now,
      defaultAgentRuntimeId: input.defaultAgentRuntimeId,
      id: input.id,
      title: input.title,
      updatedAt: input.now,
      userId: input.userId,
    };
  }

  async deleteOwned(input: {
    deletedAt: string;
    projectId: string;
    userId: string;
  }): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO archived_run_usage (
            run_id,
            user_id,
            project_id,
            project_title,
            agent_runtime_id,
            sandbox_runtime_id,
            model_id,
            status,
            input_tokens,
            output_tokens,
            total_tokens,
            model_request_count,
            sandbox_duration_ms,
            created_at,
            started_at,
            finished_at,
            deleted_at
          )
          SELECT
            agent_runs.id,
            agent_runs.user_id,
            agent_runs.project_id,
            projects.title,
            agent_runs.agent_runtime_id,
            agent_runs.sandbox_runtime_id,
            agent_runs.model_id,
            agent_runs.status,
            agent_runs.input_tokens,
            agent_runs.output_tokens,
            agent_runs.total_tokens,
            agent_runs.model_request_count,
            agent_runs.sandbox_duration_ms,
            agent_runs.created_at,
            agent_runs.started_at,
            agent_runs.finished_at,
            ?
          FROM agent_runs
          INNER JOIN projects ON projects.id = agent_runs.project_id
          WHERE projects.id = ? AND projects.user_id = ?
          ON CONFLICT(run_id) DO NOTHING`,
        )
        .bind(input.deletedAt, input.projectId, input.userId),
      this.db
        .prepare("DELETE FROM projects WHERE id = ? AND user_id = ?")
        .bind(input.projectId, input.userId),
    ]);

    return (results[1]?.meta.changes ?? 0) > 0;
  }

  async findOwnedById(projectId: string, userId: string): Promise<ProjectRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${projectColumns} FROM projects WHERE id = ? AND user_id = ? LIMIT 1`)
      .bind(projectId, userId)
      .first<ProjectRow>();

    return row === null ? null : toProjectRecord(row);
  }

  async listOwned(userId: string): Promise<ProjectRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT ${projectColumns} FROM projects WHERE user_id = ? ORDER BY updated_at DESC, id DESC`,
      )
      .bind(userId)
      .all<ProjectRow>();

    return result.results.map(toProjectRecord);
  }

  async renameOwned(input: {
    projectId: string;
    title: string;
    updatedAt: string;
    userId: string;
  }): Promise<ProjectRecord | null> {
    const result = await this.db
      .prepare(
        `UPDATE projects
        SET title = ?, updated_at = ?
        WHERE id = ? AND user_id = ?`,
      )
      .bind(input.title, input.updatedAt, input.projectId, input.userId)
      .run();
    if (result.meta.changes === 0) {
      return null;
    }

    return this.findOwnedById(input.projectId, input.userId);
  }
}

export class D1MessageRepository implements MessageRepository {
  constructor(private readonly db: D1Database) {}

  async findById(messageId: string, projectId: string): Promise<MessageRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${messageColumns} FROM messages WHERE id = ? AND project_id = ? LIMIT 1`)
      .bind(messageId, projectId)
      .first<MessageRow>();

    return row === null ? null : toMessageRecord(row);
  }

  async listByProjectId(projectId: string): Promise<MessageRecord[]> {
    const result = await this.db
      .prepare(`SELECT ${messageColumns} FROM messages WHERE project_id = ? ORDER BY sequence ASC`)
      .bind(projectId)
      .all<MessageRow>();

    return result.results.map(toMessageRecord);
  }
}
