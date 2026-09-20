import { z } from "zod";

import {
  type AgentRunStreamEvent,
  agentRunPageResponseSchema,
  agentRunResponseSchema,
  agentRunStreamEventSchema,
  apiErrorResponseSchema,
  type CreateAgentRunRequest,
  type CreateProjectRequest,
  healthResponseSchema,
  type MessagePageQuery,
  messagePageResponseSchema,
  platformCapabilitiesResponseSchema,
  projectChangeDiffResponseSchema,
  projectChangesResponseSchema,
  projectDirectoryResponseSchema,
  projectFileResponseSchema,
  projectFileUploadResponseSchema,
  projectPageResponseSchema,
  projectPreviewResponseSchema,
  projectResponseSchema,
  type TimestampCursor,
  type UpdateProjectRequest,
  userUsageResponseSchema,
} from "../shared/api";
import type { PublicErrorCode } from "../shared/error-codes";

const emptyResponseSchema = z.undefined();
const invalidJsonResponse = Symbol("invalid-json-response");

export class BrowserApiError extends Error {
  readonly code: PublicErrorCode | "network_error";
  readonly requestId: string | null;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(input: {
    code: PublicErrorCode | "network_error";
    message: string;
    requestId?: string | null;
    retryable?: boolean;
    status?: number | null;
  }) {
    super(input.message);
    this.name = "BrowserApiError";
    this.code = input.code;
    this.requestId = input.requestId ?? null;
    this.retryable = input.retryable ?? false;
    this.status = input.status ?? null;
  }
}

type RunStreamHandlers = {
  onError: (error: BrowserApiError) => void;
  onEvent: (event: AgentRunStreamEvent) => void;
};

async function requestJson<T extends z.ZodType>(
  path: string,
  schema: T,
  init: RequestInit = {},
): Promise<z.output<T>> {
  const headers = new Headers(init.headers);

  if (init.body !== undefined && !headers.has("content-type") && !(init.body instanceof FormData)) {
    headers.set("content-type", "application/json");
  }

  let response: Response;

  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers,
    });
  } catch {
    throw new BrowserApiError({
      code: "network_error",
      message: "无法连接到 Agent Online 服务。请检查网络后重试。",
    });
  }

  const body = await readJson(response);

  if (!response.ok) {
    throw toBrowserApiError(response, body);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw unrecognizedResponse(response);
  }

  return parsed.data;
}

async function readJson(response: Response): Promise<unknown> {
  let body: string;
  try {
    body = await response.text();
  } catch {
    throw unrecognizedResponse(response);
  }

  if (!body) {
    return response.status === 204 ? undefined : invalidJsonResponse;
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return invalidJsonResponse;
  }
}

function toBrowserApiError(response: Response, body: unknown) {
  const parsed = apiErrorResponseSchema.safeParse(body);
  if (parsed.success) {
    const body = parsed.data;
    return new BrowserApiError({
      code: body.error.code,
      message: messageForApiError(body.error.code),
      requestId: body.requestId,
      retryable: body.error.retryable,
      status: response.status,
    });
  }

  return unrecognizedResponse(response);
}

function unrecognizedResponse(response: Response) {
  return new BrowserApiError({
    code: "network_error",
    message: "服务返回了无法识别的响应，请稍后重试。",
    requestId: response.headers.get("x-request-id"),
    status: response.status,
  });
}

function messageForApiError(error: PublicErrorCode) {
  switch (error) {
    case "agent_runtime.unavailable":
      return "所选 Agent 当前不可用，请选择其他 Agent。";
    case "auth.unauthorized":
      return "登录状态已失效，请重新登录。";
    case "request.forbidden":
      return "你没有访问此项目的权限。";
    case "resource.limited":
      return "当前用户的并发或启动额度已用尽，请结束其他项目活动或稍后重试。";
    case "resource.not_found":
      return "未找到请求的项目或执行记录。";
    case "project_path.not_found":
      return "文件路径已不存在，请刷新目录后重试。";
    case "preview.dependencies_missing":
      return "项目依赖尚未安装，请先安装 package.json 声明的依赖。";
    case "preview.entry_missing":
      return "当前项目没有可预览的 Web 入口，请先创建 /workspace/index.html。";
    case "preview.unavailable":
      return "项目 Preview 暂时不可用，请稍后重试。";
    case "project.busy":
      return "该项目已有正在执行的任务。";
    case "run.creation_disabled":
      return "Agent Run 当前已由维护者暂停。";
    case "sandbox.not_active":
      return "项目沙箱未启动或已停止。运行一次 Agent 后再重试。";
    case "sandbox.provider_unavailable":
      return "沙箱服务暂时不可用，请稍后重试。";
    case "file.too_large":
      return "该文件超过当前操作允许的大小限制。";
    case "file.already_exists":
      return "项目根目录中已存在同名文件，请先重命名本地文件。";
    case "file.content_unsupported":
      return "当前只支持预览 UTF-8 文本文件。";
    case "project_path.unsupported":
      return "该文件路径不允许在线访问。";
    case "request.invalid":
      return "输入内容不符合要求，请检查后重试。";
    case "request.too_large":
      return "请求内容过大，请缩短输入后重试。";
    case "service.unavailable":
      return "依赖服务暂时不可用，请稍后重试。";
    case "internal.unexpected":
      return "服务暂时无法完成请求，请稍后重试。";
  }
}

function runPath(projectId: string, runId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/agent-runs/${encodeURIComponent(runId)}`;
}

function projectFilesPath(projectId: string, path: string, content = false) {
  const query = new URLSearchParams();
  if (path) {
    query.set("path", path);
  }
  const suffix = content ? "/content" : "";
  const search = query.size > 0 ? `?${query.toString()}` : "";
  return `/api/projects/${encodeURIComponent(projectId)}/files${suffix}${search}`;
}

function projectChangesPath(projectId: string, path?: string) {
  const query = new URLSearchParams();
  if (path !== undefined) {
    query.set("path", path);
  }
  const suffix = path === undefined ? "" : "/content";
  const search = query.size > 0 ? `?${query.toString()}` : "";
  return `/api/projects/${encodeURIComponent(projectId)}/changes${suffix}${search}`;
}

export const browserApi = {
  cancelAgentRun(projectId: string, runId: string) {
    return requestJson(`${runPath(projectId, runId)}/cancel`, agentRunResponseSchema, {
      method: "POST",
    });
  },

  createAgentRun(projectId: string, input: CreateAgentRunRequest) {
    return requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/agent-runs`,
      agentRunResponseSchema,
      {
        body: JSON.stringify(input),
        method: "POST",
      },
    );
  },

  createProject(input: CreateProjectRequest) {
    return requestJson("/api/projects", projectResponseSchema, {
      body: JSON.stringify(input),
      method: "POST",
    });
  },

  deleteProject(projectId: string) {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}`, emptyResponseSchema, {
      method: "DELETE",
    });
  },

  getAgentRun(projectId: string, runId: string) {
    return requestJson(runPath(projectId, runId), agentRunResponseSchema);
  },

  getActiveAgentRun(projectId: string) {
    return requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/agent-runs/active`,
      agentRunResponseSchema.nullable(),
    );
  },

  getHealth() {
    return requestJson("/api/health", healthResponseSchema);
  },

  getPlatformCapabilities() {
    return requestJson("/api/capabilities", platformCapabilitiesResponseSchema);
  },

  getProject(projectId: string) {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}`, projectResponseSchema);
  },

  getUsage() {
    return requestJson("/api/usage", userUsageResponseSchema);
  },

  listMessages(projectId: string, query: MessagePageQuery = {}) {
    return requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/messages${queryString(query)}`,
      messagePageResponseSchema,
    );
  },

  listAgentRuns(projectId: string, cursor?: TimestampCursor) {
    return requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/agent-runs${queryString({ cursor })}`,
      agentRunPageResponseSchema,
    );
  },

  listProjects(cursor?: TimestampCursor) {
    return requestJson(`/api/projects${queryString({ cursor })}`, projectPageResponseSchema);
  },

  listProjectFiles(projectId: string, path: string) {
    return requestJson(projectFilesPath(projectId, path), projectDirectoryResponseSchema);
  },

  listProjectChanges(projectId: string) {
    return requestJson(projectChangesPath(projectId), projectChangesResponseSchema);
  },

  readProjectChange(projectId: string, path: string) {
    return requestJson(projectChangesPath(projectId, path), projectChangeDiffResponseSchema);
  },

  readProjectFile(projectId: string, path: string) {
    return requestJson(projectFilesPath(projectId, path, true), projectFileResponseSchema);
  },

  getProjectPreview(projectId: string) {
    return requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/preview`,
      projectPreviewResponseSchema,
    );
  },

  startProjectPreview(projectId: string) {
    return requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/preview/start`,
      projectPreviewResponseSchema,
      { method: "POST" },
    );
  },

  stopProjectPreview(projectId: string) {
    return requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/preview/stop`,
      projectPreviewResponseSchema,
      { method: "POST" },
    );
  },

  stopProjectSandbox(projectId: string) {
    return requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/sandbox/stop`,
      projectResponseSchema,
      { method: "POST" },
    );
  },

  updateProject(projectId: string, input: UpdateProjectRequest) {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}`, projectResponseSchema, {
      body: JSON.stringify(input),
      method: "PATCH",
    });
  },

  uploadProjectFile(projectId: string, file: File) {
    const body = new FormData();
    body.set("file", file);
    return requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/files`,
      projectFileUploadResponseSchema,
      {
        body,
        method: "POST",
      },
    );
  },
};

export function subscribeToAgentRun(projectId: string, runId: string, handlers: RunStreamHandlers) {
  const source = new EventSource(`${runPath(projectId, runId)}/events`, { withCredentials: true });
  let receivedCompletion = false;

  const handleMessage = (message: MessageEvent) => {
    const event = parseRunStreamEvent(message.data);

    if (event) {
      handlers.onEvent(event);

      if (event.type === "run.completed") {
        receivedCompletion = true;
        source.close();
      }
    }
  };

  source.onmessage = handleMessage;

  source.onerror = () => {
    if (receivedCompletion) {
      return;
    }

    handlers.onError(
      new BrowserApiError({
        code: "network_error",
        message: "实时执行流暂不可用，正在继续查询任务状态。",
      }),
    );
  };

  return () => source.close();
}

function parseRunStreamEvent(value: unknown): AgentRunStreamEvent | null {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = agentRunStreamEventSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function queryString(query: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined)
      params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return params.size ? `?${params.toString()}` : "";
}
