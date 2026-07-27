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
