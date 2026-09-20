import { z } from "zod";

import { agentRunFailureCodes, publicErrorCodes } from "./error-codes";
import {
  agentRunStatuses,
  agentRuntimeIds,
  isSupportedAgentRuntimeId,
  runtimeKinds,
  sandboxChangeKinds,
  sandboxLeaseStatuses,
} from "./protocol";

const agentRuntimeIdSchema = z.enum(agentRuntimeIds);
const nonNegativeIntegerSchema = z.number().int().nonnegative();

// Public objects intentionally strip unknown fields. Server DTOs still explicitly select
// the allowed properties; these schemas do not replace owner checks or DTO allowlists.
export const healthResponseSchema = z.object({
  name: z.literal("agent-online"),
  requestId: z.string(),
  status: z.literal("ok"),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const platformCapabilitiesResponseSchema = z.object({
  agentRuntimeIds: z.array(agentRuntimeIdSchema),
  changesEnabled: z.boolean(),
  defaultAgentRuntimeId: agentRuntimeIdSchema,
  fileUploadEnabled: z.boolean(),
  runCreationEnabled: z.boolean(),
  previewEnabled: z.boolean(),
  terminalEnabled: z.boolean(),
});
export type PlatformCapabilitiesResponse = z.infer<typeof platformCapabilitiesResponseSchema>;

export const projectChangeEntryResponseSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  stagedKind: z.enum(sandboxChangeKinds).nullable(),
  unstagedKind: z.enum(sandboxChangeKinds).nullable(),
});
export type ProjectChangeEntryResponse = z.infer<typeof projectChangeEntryResponseSchema>;

export const projectChangesResponseSchema = z.object({
  entries: z.array(projectChangeEntryResponseSchema),
  repository: z.boolean(),
  truncated: z.boolean(),
  unsupportedEntries: z.boolean(),
});
export type ProjectChangesResponse = z.infer<typeof projectChangesResponseSchema>;

export const projectChangeDiffSectionResponseSchema = z.object({
  content: z.string(),
  truncated: z.boolean(),
});
export type ProjectChangeDiffSectionResponse = z.infer<
  typeof projectChangeDiffSectionResponseSchema
>;

export const projectChangeDiffResponseSchema = z.object({
  change: projectChangeEntryResponseSchema,
  staged: projectChangeDiffSectionResponseSchema.nullable(),
  unstaged: projectChangeDiffSectionResponseSchema.nullable(),
});
export type ProjectChangeDiffResponse = z.infer<typeof projectChangeDiffResponseSchema>;

export const projectPreviewResponseSchema = z.object({
  contentUrl: z.string().nullable(),
  expiresAt: z.string().nullable(),
  status: z.enum(["running", "starting", "stopped"]),
});
export type ProjectPreviewResponse = z.infer<typeof projectPreviewResponseSchema>;

export const sandboxLeaseResponseSchema = z.object({
  id: z.string(),
  runtimeId: z.enum(runtimeKinds),
  status: z.enum(sandboxLeaseStatuses),
  updatedAt: z.string(),
});
export type SandboxLeaseResponse = z.infer<typeof sandboxLeaseResponseSchema>;

export const projectResponseSchema = z.object({
  createdAt: z.string(),
  defaultAgentRuntimeId: agentRuntimeIdSchema,
  id: z.string(),
  sandboxLease: sandboxLeaseResponseSchema.nullable(),
  title: z.string(),
  updatedAt: z.string(),
});
export type ProjectResponse = z.infer<typeof projectResponseSchema>;

export const messageResponseSchema = z.object({
  agentRunId: z.string().nullable(),
  content: z.string(),
  createdAt: z.string(),
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  sequence: nonNegativeIntegerSchema,
});
export type MessageResponse = z.infer<typeof messageResponseSchema>;

export const agentRunUsageResponseSchema = z.object({
  inputTokens: nonNegativeIntegerSchema,
  modelRequestCount: nonNegativeIntegerSchema,
  outputTokens: nonNegativeIntegerSchema,
  sandboxDurationMs: nonNegativeIntegerSchema,
  totalTokens: nonNegativeIntegerSchema,
});
export type AgentRunUsageResponse = z.infer<typeof agentRunUsageResponseSchema>;

export const usageMetricsResponseSchema = agentRunUsageResponseSchema.extend({
  runCount: nonNegativeIntegerSchema,
});
export type UsageMetricsResponse = z.infer<typeof usageMetricsResponseSchema>;

export const userUsageResponseSchema = z.object({
  agentRuntimes: z.array(
    z.object({
      agentRuntimeId: z.string().min(1),
      usage: usageMetricsResponseSchema,
    }),
  ),
  projects: z.array(
    z.object({
      projectDeleted: z.boolean(),
      projectId: z.string(),
      projectTitle: z.string(),
      usage: usageMetricsResponseSchema,
    }),
  ),
  scope: z.literal("all_time"),
  totals: usageMetricsResponseSchema,
});
export type UserUsageResponse = z.infer<typeof userUsageResponseSchema>;

export const agentRunResponseSchema = z.object({
  agentRuntimeId: z.string().min(1),
  createdAt: z.string(),
  failureCode: z.enum(agentRunFailureCodes).nullable(),
  finishedAt: z.string().nullable(),
  id: z.string(),
  inputMessageId: z.string().nullable(),
  modelId: z.string(),
  sandboxLeaseId: z.string(),
  sandboxRuntimeId: z.enum(runtimeKinds),
  startedAt: z.string().nullable(),
  status: z.enum(agentRunStatuses),
  usage: agentRunUsageResponseSchema,
});
export type AgentRunResponse = z.infer<typeof agentRunResponseSchema>;

export const listPageSize = 50;
const timestampCursorSchema = z
  .object({ at: z.string().datetime(), id: z.string().min(1).max(200) })
  .strict();
export type TimestampCursor = z.infer<typeof timestampCursorSchema>;
export const listPageQuerySchema = z
  .object({
    cursor: z
      .string()
      .max(500)
      .transform((value, context) => {
        try {
          const parsed = timestampCursorSchema.safeParse(JSON.parse(value));
          if (parsed.success) return parsed.data;
        } catch {
          /* Report only a public validation failure. */
        }
        context.addIssue({ code: "custom", message: "Invalid cursor" });
        return z.NEVER;
      })
      .optional(),
  })
  .strict();
export const messagePageQuerySchema = z
  .object({
    before: z.coerce.number().int().positive().safe().optional(),
    after: z.coerce.number().int().nonnegative().safe().optional(),
  })
  .strict()
  .refine((value) => value.before === undefined || value.after === undefined);
export type MessagePageQuery = z.infer<typeof messagePageQuerySchema>;
export const projectPageResponseSchema = z.object({
  items: z.array(projectResponseSchema),
  nextCursor: timestampCursorSchema.nullable(),
});
export const agentRunPageResponseSchema = z.object({
  items: z.array(agentRunResponseSchema),
  nextCursor: timestampCursorSchema.nullable(),
});
export const messagePageResponseSchema = z.object({
  items: z.array(messageResponseSchema),
  nextCursor: nonNegativeIntegerSchema.nullable(),
});
export type ProjectPageResponse = z.infer<typeof projectPageResponseSchema>;
export type AgentRunPageResponse = z.infer<typeof agentRunPageResponseSchema>;
export type MessagePageResponse = z.infer<typeof messagePageResponseSchema>;

export const createProjectRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const updateProjectRequestSchema = createProjectRequestSchema;
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

export const createAgentRunRequestSchema = z.object({
  // Reserved identifiers remain representable in public records, but cannot start a Run.
  // The server registry additionally checks the deployment's enabled runtimes.
  agentRuntimeId: agentRuntimeIdSchema.refine(isSupportedAgentRuntimeId).optional(),
  content: z.string().trim().min(1).max(64_000),
});
export type CreateAgentRunRequest = z.infer<typeof createAgentRunRequestSchema>;

export const projectFileEntryResponseSchema = z.object({
  kind: z.enum(["directory", "file", "symlink"]),
  modifiedAt: z.string().nullable(),
  name: z.string(),
  path: z.string(),
  size: nonNegativeIntegerSchema,
});
export type ProjectFileEntryResponse = z.infer<typeof projectFileEntryResponseSchema>;

export const projectDirectoryResponseSchema = z.object({
  entries: z.array(projectFileEntryResponseSchema),
  path: z.string(),
  truncated: z.boolean(),
});
export type ProjectDirectoryResponse = z.infer<typeof projectDirectoryResponseSchema>;

export const projectFileResponseSchema = z.object({
  content: z.string(),
  modifiedAt: z.string().nullable(),
  name: z.string(),
  path: z.string(),
  size: nonNegativeIntegerSchema,
});
export type ProjectFileResponse = z.infer<typeof projectFileResponseSchema>;

export const projectFileUploadResponseSchema = z.object({
  name: z.string(),
  path: z.string(),
  size: nonNegativeIntegerSchema,
});
export type ProjectFileUploadResponse = z.infer<typeof projectFileUploadResponseSchema>;

export const agentRunStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    sequence: nonNegativeIntegerSchema,
    status: z.enum(agentRunStatuses),
    type: z.literal("run.status"),
  }),
  z.object({
    sequence: nonNegativeIntegerSchema,
    type: z.literal("run.completed"),
    usage: agentRunUsageResponseSchema,
  }),
]);
export type AgentRunStreamEvent = z.infer<typeof agentRunStreamEventSchema>;

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.enum(publicErrorCodes),
    retryable: z.boolean(),
  }),
  requestId: z.string(),
});
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
