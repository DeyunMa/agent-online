import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  customType,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import type { AgentRuntimeId } from "../../agent/contract";
import type { AgentRunStatus } from "../../domain/agent-run";
import type { SandboxLeaseStatus } from "../../domain/sandbox-lease";
import type { RuntimeKind } from "../../runtime/contract";
import type { AgentRunFailureCode } from "../../shared/error-codes";

// This is the typed mapping of migrations/0001–0008, not a second migration
// history. Better Auth owns its DATE values and continues using its D1 adapter.
const authDate = customType<{ data: string | number; driverData: string | number }>({
  dataType: () => "date",
});

export const users = sqliteTable("user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: integer().notNull(),
  image: text(),
  createdAt: authDate().notNull(),
  updatedAt: authDate().notNull(),
});

export const sessions = sqliteTable(
  "session",
  {
    id: text().primaryKey(),
    expiresAt: authDate().notNull(),
    token: text().notNull().unique(),
    createdAt: authDate().notNull(),
    updatedAt: authDate().notNull(),
    ipAddress: text(),
    userAgent: text(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const accounts = sqliteTable(
  "account",
  {
    id: text().primaryKey(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: authDate(),
    refreshTokenExpiresAt: authDate(),
    scope: text(),
    password: text(),
    createdAt: authDate().notNull(),
    updatedAt: authDate().notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verifications = sqliteTable(
  "verification",
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: authDate().notNull(),
    createdAt: authDate().notNull(),
    updatedAt: authDate().notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text().notNull(),
    default_agent_runtime_id: text().$type<AgentRuntimeId>().notNull().default("pi"),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (table) => [
    index("projects_by_user_updated_at").on(table.user_id, sql`${table.updated_at} desc`),
  ],
);

export const sandboxLeases = sqliteTable(
  "sandbox_leases",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .unique()
      .references(() => projects.id, { onDelete: "cascade" }),
    sandbox_runtime_id: text().$type<RuntimeKind>().notNull(),
    provider_ref: text(),
    status: text().$type<SandboxLeaseStatus>().notNull(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (table) => [
    index("sandbox_leases_by_status").on(table.status),
    check(
      "sandbox_leases_status",
      sql`${table.status} in ('stopped', 'starting', 'ready', 'busy', 'idle', 'failed')`,
    ),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agent_run_id: text().references((): AnySQLiteColumn => agentRuns.id, { onDelete: "set null" }),
    sequence: integer().notNull(),
    role: text().$type<"user" | "assistant">().notNull(),
    content: text().notNull(),
    created_at: text().notNull(),
  },
  (table) => [
    unique().on(table.project_id, table.sequence),
    index("messages_by_project_created_at").on(table.project_id, sql`${table.created_at} asc`),
    uniqueIndex("messages_one_assistant_per_run")
      .on(table.agent_run_id)
      .where(sql`${table.role} = 'assistant' and ${table.agent_run_id} is not null`),
    check("messages_sequence", sql`${table.sequence} >= 0`),
    check("messages_role", sql`${table.role} in ('user', 'assistant')`),
  ],
);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    project_id: text()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    input_message_id: text().references((): AnySQLiteColumn => messages.id, {
      onDelete: "set null",
    }),
    sandbox_lease_id: text()
      .notNull()
      .references(() => sandboxLeases.id, { onDelete: "restrict" }),
    agent_runtime_id: text().$type<AgentRuntimeId>().notNull(),
    sandbox_runtime_id: text().$type<RuntimeKind>().notNull(),
    model_id: text().notNull(),
    status: text().$type<AgentRunStatus>().notNull(),
    input_tokens: integer().notNull().default(0),
    output_tokens: integer().notNull().default(0),
    total_tokens: integer().notNull().default(0),
    model_request_count: integer().notNull().default(0),
    sandbox_duration_ms: integer().notNull().default(0),
    // Physical legacy column is retained by deployed migrations, never read into
    // an application record. State transitions keep it NULL.
    failure_reason: text(),
    created_at: text().notNull(),
    started_at: text(),
    finished_at: text(),
    provider_process_ref: text(),
    failure_code: text().$type<AgentRunFailureCode>(),
  },
  (table) => [
    index("agent_runs_by_project_created_at").on(table.project_id, sql`${table.created_at} desc`),
    index("agent_runs_by_user_created_at").on(table.user_id, sql`${table.created_at} desc`),
    uniqueIndex("agent_runs_one_active_per_project")
      .on(table.project_id)
      .where(sql`${table.status} in ('queued', 'starting', 'running', 'cancelling')`),
    check(
      "agent_runs_status",
      sql`${table.status} in ('queued', 'starting', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')`,
    ),
    check("agent_runs_input_tokens", sql`${table.input_tokens} >= 0`),
    check("agent_runs_output_tokens", sql`${table.output_tokens} >= 0`),
    check("agent_runs_total_tokens", sql`${table.total_tokens} >= 0`),
    check("agent_runs_model_request_count", sql`${table.model_request_count} >= 0`),
    check("agent_runs_sandbox_duration_ms", sql`${table.sandbox_duration_ms} >= 0`),
    check(
      "agent_runs_failure_code",
      sql`${table.failure_code} is null or ${table.failure_code} in ('run.start_failed', 'run.sandbox_failed', 'run.agent_protocol_failed', 'run.agent_process_failed', 'run.model_failed', 'run.no_visible_reply', 'run.timed_out', 'run.interrupted', 'run.internal_failed')`,
    ),
  ],
);

export const terminalSessions = sqliteTable("terminal_sessions", {
  id: text().primaryKey(),
  project_id: text()
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: "cascade" }),
  sandbox_lease_id: text()
    .notNull()
    .references(() => sandboxLeases.id, { onDelete: "cascade" }),
  provider_sandbox_ref: text(),
  provider_process_ref: text(),
  expires_at: text().notNull(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
});

export const previewSessions = sqliteTable(
  "preview_sessions",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .unique()
      .references(() => projects.id, { onDelete: "cascade" }),
    sandbox_lease_id: text()
      .notNull()
      .references(() => sandboxLeases.id, { onDelete: "cascade" }),
    provider_sandbox_ref: text().notNull(),
    provider_process_ref: text(),
    status: text().$type<"starting" | "running">().notNull(),
    port: integer().notNull(),
    expires_at: text().notNull(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (table) => [
    check("preview_sessions_status", sql`${table.status} in ('starting', 'running')`),
    check("preview_sessions_port", sql`${table.port} = 3000`),
  ],
);

export const archivedRunUsage = sqliteTable(
  "archived_run_usage",
  {
    run_id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    project_id: text().notNull(),
    project_title: text().notNull(),
    agent_runtime_id: text().$type<AgentRuntimeId>().notNull(),
    sandbox_runtime_id: text().$type<RuntimeKind>().notNull(),
    model_id: text().notNull(),
    status: text()
      .$type<
        Extract<AgentRunStatus, "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted">
      >()
      .notNull(),
    input_tokens: integer().notNull(),
    output_tokens: integer().notNull(),
    total_tokens: integer().notNull(),
    model_request_count: integer().notNull(),
    sandbox_duration_ms: integer().notNull(),
    created_at: text().notNull(),
    started_at: text(),
    finished_at: text(),
    deleted_at: text().notNull(),
  },
  (table) => [
    index("archived_run_usage_by_user_created_at").on(table.user_id, sql`${table.created_at} desc`),
    index("archived_run_usage_by_user_project").on(table.user_id, table.project_id),
    index("archived_run_usage_by_user_agent_runtime").on(table.user_id, table.agent_runtime_id),
    check(
      "archived_run_usage_status",
      sql`${table.status} in ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')`,
    ),
    check("archived_run_usage_input_tokens", sql`${table.input_tokens} >= 0`),
    check("archived_run_usage_output_tokens", sql`${table.output_tokens} >= 0`),
    check("archived_run_usage_total_tokens", sql`${table.total_tokens} >= 0`),
    check("archived_run_usage_model_request_count", sql`${table.model_request_count} >= 0`),
    check("archived_run_usage_sandbox_duration_ms", sql`${table.sandbox_duration_ms} >= 0`),
  ],
);
