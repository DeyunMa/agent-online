import { and, asc, desc, eq, getTableColumns, gt, lt, or, sql } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import type {
  MessageContextRecord,
  MessageContextRepository,
  MessageRecord,
  MessageRepository,
  ProjectRecord,
  ProjectRepository,
} from "../../application/ports";
import { maxHistoryBytes, maxHistoryMessages } from "../../application/run-context";
import { listPageSize, type MessagePageQuery, type TimestampCursor } from "../../shared/api";
import { toMessageRecord, toProjectRecord } from "./d1-records";
import { messages, projects } from "./schema";

export class D1ProjectRepository implements ProjectRepository {
  private readonly orm: DrizzleD1Database;

  constructor(private readonly db: D1Database) {
    this.orm = drizzle(db);
  }

  async create(
    input: Omit<ProjectRecord, "createdAt" | "updatedAt"> & { now: string },
  ): Promise<ProjectRecord> {
    await this.orm
      .insert(projects)
      .values({
        id: input.id,
        user_id: input.userId,
        title: input.title,
        default_agent_runtime_id: input.defaultAgentRuntimeId,
        created_at: input.now,
        updated_at: input.now,
      })
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
    const row = await this.orm
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.user_id, userId)))
      .get();

    return row === undefined ? null : toProjectRecord(row);
  }

  async listOwned(userId: string, cursor?: TimestampCursor): Promise<ProjectRecord[]> {
    const rows = await this.orm
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.user_id, userId),
          cursor
            ? or(
                lt(projects.updated_at, cursor.at),
                and(eq(projects.updated_at, cursor.at), lt(projects.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(projects.updated_at), desc(projects.id))
      .limit(listPageSize + 1)
      .all();

    return rows.map(toProjectRecord);
  }

  async renameOwned(input: {
    projectId: string;
    title: string;
    updatedAt: string;
    userId: string;
  }): Promise<ProjectRecord | null> {
    const row = await this.orm
      .update(projects)
      .set({ title: input.title, updated_at: input.updatedAt })
      .where(and(eq(projects.id, input.projectId), eq(projects.user_id, input.userId)))
      .returning()
      .get();

    return row === undefined ? null : toProjectRecord(row);
  }
}

export class D1MessageRepository implements MessageRepository, MessageContextRepository {
  private readonly orm: DrizzleD1Database;

  constructor(db: D1Database) {
    this.orm = drizzle(db);
  }

  async listContextBefore(projectId: string, sequence: number): Promise<MessageContextRecord[]> {
    const rows = await this.orm
      .select({
        ...getTableColumns(messages),
        content: sql<
          string | null
        >`case when length(cast(${messages.content} as blob)) <= ${maxHistoryBytes} then ${messages.content} else null end`,
      })
      .from(messages)
      .where(and(eq(messages.project_id, projectId), lt(messages.sequence, sequence)))
      .orderBy(desc(messages.sequence))
      .limit(maxHistoryMessages + 1)
      .all();
    // Null is an omission marker; preserve all bytes (including embedded NUL) of
    // smaller messages rather than substringing SQLite TEXT.
    return rows.map((row) => ({
      ...toMessageRecord({ ...row, content: row.content ?? "" }),
      content: row.content,
    }));
  }

  async findById(messageId: string, projectId: string): Promise<MessageRecord | null> {
    const row = await this.orm
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.project_id, projectId)))
      .get();

    return row === undefined ? null : toMessageRecord(row);
  }

  async listByProjectId(projectId: string, query: MessagePageQuery = {}): Promise<MessageRecord[]> {
    const rows = await this.orm
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.project_id, projectId),
          query.before !== undefined ? lt(messages.sequence, query.before) : undefined,
          query.after !== undefined ? gt(messages.sequence, query.after) : undefined,
        ),
      )
      .orderBy(query.after !== undefined ? asc(messages.sequence) : desc(messages.sequence))
      .limit(listPageSize + 1)
      .all();

    return rows.map(toMessageRecord);
  }
}
