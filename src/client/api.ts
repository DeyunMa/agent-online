import type {
  AgentRunResponse,
  AgentRunStreamEvent,
  ApiErrorResponse,
  CreateAgentRunRequest,
  CreateProjectRequest,
  HealthResponse,
  MessageResponse,
  ProjectResponse,
} from "../shared/api";

export class BrowserApiError extends Error {
  readonly code: ApiErrorResponse["error"] | "network_error";
  readonly requestId: string | null;
  readonly status: number | null;

  constructor(input: {
    code: ApiErrorResponse["error"] | "network_error";
    message: string;
    requestId?: string | null;
    status?: number | null;
  }) {
    super(input.message);
    this.name = "BrowserApiError";
    this.code = input.code;
    this.requestId = input.requestId ?? null;
    this.status = input.status ?? null;
  }
}

type RunStreamHandlers = {
  onError: (error: BrowserApiError) => void;
  onEvent: (event: AgentRunStreamEvent) => void;
};

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);

  if (init.body !== undefined && !headers.has("content-type")) {
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
    throw toBrowserApiError(response.status, body);
  }

  return body as T;
}

async function readJson(response: Response): Promise<unknown> {
  const body = await response.text();

  if (!body) {
    return undefined;
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function toBrowserApiError(status: number, body: unknown) {
  if (isApiErrorResponse(body)) {
    return new BrowserApiError({
      code: body.error,
      message: messageForApiError(body.error),
      requestId: body.requestId,
      status,
    });
  }

  return new BrowserApiError({
    code: "network_error",
    message: "服务返回了无法识别的响应，请稍后重试。",
    status,
  });
}

function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    "requestId" in value &&
    typeof value.error === "string" &&
    typeof value.requestId === "string"
  );
}

function messageForApiError(error: ApiErrorResponse["error"]) {
  switch (error) {
    case "unauthorized":
      return "登录状态已失效，请重新登录。";
    case "forbidden":
      return "你没有访问此项目的权限。";
    case "not_found":
      return "未找到请求的项目或执行记录。";
    case "project_busy":
      return "该项目已有正在执行的任务。";
    case "validation_error":
      return "输入内容不符合要求，请检查后重试。";
    case "internal_error":
      return "服务暂时无法完成请求，请稍后重试。";
  }
}

function runPath(projectId: string, runId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/agent-runs/${encodeURIComponent(runId)}`;
}

export const browserApi = {
  cancelAgentRun(projectId: string, runId: string) {
    return requestJson<AgentRunResponse>(`${runPath(projectId, runId)}/cancel`, { method: "POST" });
  },

  createAgentRun(projectId: string, input: CreateAgentRunRequest) {
    return requestJson<AgentRunResponse>(`/api/projects/${encodeURIComponent(projectId)}/agent-runs`, {
      body: JSON.stringify(input),
      method: "POST",
    });
  },

  createProject(input: CreateProjectRequest) {
    return requestJson<ProjectResponse>("/api/projects", {
      body: JSON.stringify(input),
      method: "POST",
    });
  },

  getAgentRun(projectId: string, runId: string) {
    return requestJson<AgentRunResponse>(runPath(projectId, runId));
  },

  getActiveAgentRun(projectId: string) {
    return requestJson<AgentRunResponse | null>(`/api/projects/${encodeURIComponent(projectId)}/agent-runs/active`);
  },

  getHealth() {
    return requestJson<HealthResponse>("/api/health");
  },

  getProject(projectId: string) {
    return requestJson<ProjectResponse>(`/api/projects/${encodeURIComponent(projectId)}`);
  },

  listMessages(projectId: string) {
    return requestJson<MessageResponse[]>(`/api/projects/${encodeURIComponent(projectId)}/messages`);
  },

  listProjects() {
    return requestJson<ProjectResponse[]>("/api/projects");
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

  for (const eventType of ["run.status", "agent.output", "agent.tool.started", "run.completed"]) {
    source.addEventListener(eventType, handleMessage);
  }

  source.onerror = () => {
    if (receivedCompletion || source.readyState === EventSource.CLOSED) {
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
    const event = JSON.parse(value) as AgentRunStreamEvent;
    return "type" in event ? event : null;
  } catch {
    return null;
  }
}
