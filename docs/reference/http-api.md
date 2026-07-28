# HTTP、SSE 与 WebSocket 接口设计

> 文档状态：当前公开接口基准
>
> 校准日期：2026-07-28
>
> 权威来源：`src/server/` 路由和 `src/shared/` 公开 DTO

所有产品接口与 React UI 同域，基础路径为 `/api`。除健康检查、能力发现、Better Auth 入口和持 capability 的 Preview/ModelGateway 请求外，产品接口都要求 Better Auth 会话。

## 1. 通用约定

### 1.1 鉴权与所有权

- 浏览器登录状态由 Better Auth 的同源 cookie 提供。
- Project 子资源接口先按当前 User 查询 Project；不是所有者时统一返回 `404 resource.not_found`，不暴露资源是否存在。
- Terminal WebSocket、Preview start/stop 额外要求 `Origin` 与请求 URL 同源。
- Preview 内容使用短时签名 capability URL，不向上游暴露 Provider host/port/token。
- ModelGateway 使用只绑定一个 Run、Project、Model 和期限的 Bearer capability，不接受浏览器会话替代。
- 普通产品 mutation 必须携带精确同源 `Origin`，或由浏览器提供
  `Sec-Fetch-Site: same-origin`；在鉴权和 JSON 解析前统一限制请求体为 256 KiB。
  Better Auth 与 ModelGateway 使用各自协议，不经过该产品 guard。

### 1.2 请求追踪

Worker 为每个请求生成 `requestId`：

- 响应头：`x-request-id: <uuid>`
- 普通 API 错误体：`{ "error": { "code": "<code>", "retryable": false }, "requestId": "<uuid>" }`

Provider 私有错误、密钥、sandbox ID 和 process ID 不进入公开错误体。

`requestId` 只关联一次 Worker invocation；跨创建请求、Workflow、ModelGateway、取消和
idle cleanup 的完整 AgentRun 使用已有 `runId` 关联。平台不额外持久化重复的
`trace_id`。

### 1.3 普通错误模型

```ts
type ApiErrorResponse = {
  error: {
    code: PublicErrorCode;
    retryable: boolean;
  };
  requestId: string;
};
```

| Code | HTTP | Retryable | 含义 |
| --- | --- | --- | --- |
| `auth.unauthorized` | `401` | false | 没有有效登录会话。 |
| `request.forbidden` | `403` | false | 同源或权限检查失败。 |
| `request.too_large` | `413` | false | 普通产品请求体超过 256 KiB。 |
| `request.invalid` | `400` | false | JSON 或字段不合法。 |
| `resource.not_found` | `404` | false | 路由或所有权过滤后的资源不存在。 |
| `project.busy` | `409` | true | 当前 Run、Terminal 或 Preview 启动占用 Project。 |
| `run.creation_disabled` | `503` | false | 维护者关闭了新 Run。 |
| `agent_runtime.unavailable` | `409` | false | Runtime 未公开或未启用。 |
| `sandbox.not_active` | `409` | false | Project 当前没有可附着的沙箱。 |
| `sandbox.provider_unavailable` | `503` | true | Sandbox Provider 调用失败。 |
| `project_path.not_found` | `404` | false | 文件或 Changes 路径不存在。 |
| `project_path.unsupported` | `400` | false | 路径超出受控范围。 |
| `file.too_large` | `413` | false | 文件超过读取上限。 |
| `file.content_unsupported` | `415` | false | 不是可公开的 UTF-8 文本。 |
| `preview.unavailable` | `503` | true | 固定 Preview 无法启动或访问。 |
| `service.unavailable` | `503` | true | 通用依赖暂不可用。 |
| `internal.unexpected` | `500` | true | 未知内部错误；使用 `requestId` 定位。 |

`retryable=true` 只允许 UI 提示用户人工重试，不能自动重放非幂等 POST。普通产品 API
只能通过 `src/server/http/api-errors.ts` 输出该结构。Better Auth、Terminal WebSocket、
Preview 内容代理和 ModelGateway 保留各自已有的协议 envelope。

### 1.4 响应安全头

- 所有 `/api/*` 响应由 Hono 添加 MIME、frame、referrer、opener 等基线安全头；
  Preview 内容路由仍可按其 opaque iframe 边界覆盖更严格的 CSP/CORP。
- React/静态 Assets 由 `public/_headers` 声明 CSP、`frame-ancestors`、referrer 和
  MIME 防护；production build 会验证 `_headers` 已进入 `dist`。

## 2. 公开 DTO

下列结构省略了 API 从不返回的 `user_id`、Provider 引用、密钥和内部端口。

```ts
type ProjectResponse = {
  id: string;
  title: string;
  defaultAgentRuntimeId: "pi" | "goose" | "claude-code" | "codex-cli";
  createdAt: string;
  updatedAt: string;
  sandboxLease: null | {
    id: string;
    runtimeId: "fake" | "e2b" | "cloudflare-container";
    status: "stopped" | "starting" | "ready" | "busy" | "idle" | "failed";
    updatedAt: string;
  };
};

type MessageResponse = {
  id: string;
  agentRunId: string | null;
  sequence: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

type AgentRunResponse = {
  id: string;
  inputMessageId: string | null;
  sandboxLeaseId: string;
  agentRuntimeId: "pi" | "goose" | "claude-code" | "codex-cli";
  sandboxRuntimeId: "fake" | "e2b" | "cloudflare-container";
  modelId: string;
  status:
    | "queued" | "starting" | "running" | "cancelling"
    | "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted";
  failureCode:
    | "run.start_failed"
    | "run.sandbox_failed"
    | "run.agent_protocol_failed"
    | "run.agent_process_failed"
    | "run.model_failed"
    | "run.no_visible_reply"
    | "run.timed_out"
    | "run.interrupted"
    | "run.internal_failed"
    | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    modelRequestCount: number;
    sandboxDurationMs: number;
  };
};
```

类型联合中保留了未来 Runtime ID，但实际可执行和公开集合必须以 `/api/capabilities` 及服务端 policy 为准。

## 3. 系统、能力与认证

| 方法 | 路径 | 鉴权 | 成功响应 | 说明 |
| --- | --- | --- | --- | --- |
| `GET` | `/api/health` | 无 | `200 HealthResponse` | Worker 存活检查。 |
| `GET` | `/api/capabilities` | 无 | `200 PlatformCapabilitiesResponse` | 返回当前公开 AgentRuntime 和 Changes/Terminal/Preview/Run 开关；Files 由现有 Lease/Runtime 状态决定。 |
| `GET/POST` | `/api/auth/*` | Better Auth | Better Auth 标准响应 | 邮箱密码注册、登录、会话和退出。 |

能力响应：

```ts
type PlatformCapabilitiesResponse = {
  agentRuntimeIds: Array<"pi" | "goose" | "claude-code" | "codex-cli">;
  defaultAgentRuntimeId: "pi" | "goose" | "claude-code" | "codex-cli";
  runCreationEnabled: boolean;
  changesEnabled: boolean;
  previewEnabled: boolean;
  terminalEnabled: boolean;
};
```

当前浏览器使用的 Better Auth 操作是：

- `POST /api/auth/sign-up/email`
- `POST /api/auth/sign-in/email`
- `GET /api/auth/get-session`
- `POST /api/auth/sign-out`

Better Auth 可能提供其他内部标准路径，但它们不是 Agent Online 自定义产品契约。

## 4. Project 和 Message

| 方法 | 路径 | 请求 | 成功响应 | 主要错误 |
| --- | --- | --- | --- | --- |
| `GET` | `/api/projects` | 无 | `200 ProjectResponse[]` | `401` |
| `POST` | `/api/projects` | `{ "title": string }` | `201 ProjectResponse` | `400`、`401` |
| `GET` | `/api/projects/:projectId` | 无 | `200 ProjectResponse` | `401`、`404` |
| `GET` | `/api/projects/:projectId/messages` | 无 | `200 MessageResponse[]` | `401`、`404` |
| `POST` | `/api/projects/:projectId/sandbox/stop` | 无 | `200 ProjectResponse` | `401`、`404`、`409`、`503` |

行为说明：

- 新 Project 的 `defaultAgentRuntimeId` 固定为 `pi`。
- 列表按 `updated_at DESC, id DESC` 返回，当前没有分页。
- Message 按 `sequence ASC` 返回，当前没有分页。
- 手动停止先以 D1 条件更新脱离 Provider 引用，再调用 Provider；活动 Run、Terminal 或 Preview 会阻止停止。
- 当前没有 Project 更新、删除、分享或成员接口。

## 5. AgentRun

| 方法 | 路径 | 请求 | 成功响应 | 主要错误 |
| --- | --- | --- | --- | --- |
| `POST` | `/api/projects/:projectId/agent-runs` | `{ "content": string, "agentRuntimeId"?: string }` | `201 AgentRunResponse` | `400`、`401`、`404`、`409`、`503` |
| `GET` | `/api/projects/:projectId/agent-runs` | 无 | `200 AgentRunResponse[]` | `401`、`404` |
| `GET` | `/api/projects/:projectId/agent-runs/active` | 无 | `200 AgentRunResponse \| null` | `401`、`404` |
| `GET` | `/api/projects/:projectId/agent-runs/:runId` | 无 | `200 AgentRunResponse` | `401`、`404` |
| `POST` | `/api/projects/:projectId/agent-runs/:runId/cancel` | 无 | `200 AgentRunResponse` | `401`、`404`、`500` |
| `GET` | `/api/projects/:projectId/agent-runs/:runId/events` | 无 | `200 text/event-stream` | `401`、`404` |

创建语义：

- `content` 经过 trim 后必须为 1 至 64,000 个字符。
- 未传 `agentRuntimeId` 时使用 Project 默认值。
- Runtime 必须在服务端 execution policy 中启用；浏览器 UI 只应使用 capability 返回的 public Runtime。
- 用户 Message 与 queued AgentRun 原子创建；成功完成时，Run 终态、sandbox duration、最终 assistant Message 和 Project touch 也在一个 D1 batch 中提交。
- 同一 Project 已有非终态 Run或活动 Terminal/正在启动的 Preview 时返回
  `409 project.busy`，不创建第二条 Run。
- `RUNS_ENABLED=false` 时返回 `503 run.creation_disabled`，且不写入 Message、Lease 或
  AgentRun。

列表只返回当前 Project 最新 50 条 AgentRun。

终态失败只返回稳定 `failureCode`，浏览器负责本地化文案。`succeeded` 和 `cancelled`
必须为 `null`；`timed_out`、`interrupted` 使用同名固定 code；`failed` 必须使用其余
失败 code 之一。Provider status、exit code、异常 message 和 stack 不属于该 DTO。

### 5.1 SSE 协议

每个 SSE frame 的 `data` 是一个 JSON 对象，`sequence` 只在当前连接内递增：

```ts
type AgentRunStreamEvent =
  | {
      type: "run.status";
      sequence: number;
      status: AgentRunResponse["status"];
    }
  | {
      type: "run.completed";
      sequence: number;
      usage: AgentRunResponse["usage"];
    };
```

当前实现：

- 连接后立即发送一次 `run.status`。
- Worker 每 750 ms 从 D1 读取 Run；状态变化时发送新的 `run.status`。
- 进入终态后发送一次 `run.completed` 并结束流。
- 客户端断开时停止后续 D1 轮询；SSE 不是后台执行所有者。
- 最终 assistant 回复不通过 SSE 发送，浏览器随后刷新 Message API。

SSE 不是可重放事件日志：没有持久 event ID，也不保存 raw Agent 输出。

## 6. Files

| 方法 | 路径 | 查询参数 | 成功响应 | 主要错误 |
| --- | --- | --- | --- | --- |
| `GET` | `/api/projects/:projectId/files` | `path` 可选；空值表示 `/workspace` | `200 ProjectDirectoryResponse` | `400`、`401`、`404`、`409`、`503` |
| `GET` | `/api/projects/:projectId/files/content` | `path` 必填 | `200 ProjectFileResponse` | `400`、`401`、`404`、`409`、`413`、`415`、`503` |

```ts
type ProjectDirectoryResponse = {
  path: string;
  truncated: boolean;
  entries: Array<{
    kind: "directory" | "file" | "symlink";
    modifiedAt: string | null;
    name: string;
    path: string;
    size: number;
  }>;
};

type ProjectFileResponse = {
  content: string;
  modifiedAt: string | null;
  name: string;
  path: string;
  size: number;
};
```

Files 只附着现有且可读取的 Lease，不会为了浏览文件创建新沙箱。路径、大小、文本类型和互斥限制见 [平台限制](./platform-limits.md)。

## 7. Changes

| 方法 | 路径 | 查询参数 | 成功响应 | 主要错误 |
| --- | --- | --- | --- | --- |
| `GET` | `/api/projects/:projectId/changes` | 无 | `200 ProjectChangesResponse` | `401`、`404`、`409`、`500`、`503` |
| `GET` | `/api/projects/:projectId/changes/content` | `path` 必填 | `200 ProjectChangeDiffResponse` | `400`、`401`、`404`、`409`、`500`、`503` |

```ts
type ProjectChangeEntryResponse = {
  path: string;
  previousPath: string | null;
  stagedKind:
    | "added" | "conflicted" | "deleted" | "modified"
    | "renamed" | "type_changed" | null;
  unstagedKind:
    | "conflicted" | "deleted" | "modified" | "renamed"
    | "type_changed" | "untracked" | null;
};

type ProjectChangesResponse = {
  repository: boolean;
  truncated: boolean;
  unsupportedEntries: boolean;
  entries: ProjectChangeEntryResponse[];
};

type ProjectChangeDiffResponse = {
  change: ProjectChangeEntryResponse;
  staged: { content: string; truncated: boolean } | null;
  unstaged: { content: string; truncated: boolean } | null;
};
```

语义：

- `repository=false` 表示 `/workspace` 当前不是 Git repository。
- `truncated=true` 表示 status 受条目数或字节上限截断。
- `unsupportedEntries=true` 表示存在不能安全公开的合法 Git 路径；UI 不得把结果显示为 clean。
- 所有 Changes 响应都设置 `cache-control: private, no-store`。

## 8. Usage

| 方法 | 路径 | 鉴权 | 成功响应 |
| --- | --- | --- | --- |
| `GET` | `/api/usage` | 当前 User | `200 UserUsageResponse` |

```ts
type UsageMetricsResponse = {
  runCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  modelRequestCount: number;
  sandboxDurationMs: number;
};

type UserUsageResponse = {
  scope: "all_time";
  totals: UsageMetricsResponse;
  projects: Array<{
    projectId: string;
    projectTitle: string;
    usage: UsageMetricsResponse;
  }>;
  agentRuntimes: Array<{
    agentRuntimeId: string;
    usage: UsageMetricsResponse;
  }>;
};
```

该接口是运行事实聚合，不是账单、余额或配额接口。

## 9. Terminal WebSocket

连接：

```text
GET /api/projects/:projectId/terminal
Upgrade: websocket
Origin: <same origin>
```

成功后返回 `101 Switching Protocols`。必须登录、拥有 Project 且通过同源检查。

### 9.1 客户端文本控制帧

第一帧必须在 10 秒内发送 `attach`：

```ts
type TerminalClientMessage =
  | { type: "attach"; cols: number; rows: number }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "close" };
```

### 9.2 服务端帧

- PTY 输出：二进制 WebSocket frame。
- 控制消息：JSON 文本 frame。

```ts
type TerminalServerMessage =
  | { type: "ready"; expiresAt: string }
  | { type: "closed"; exitCode: number }
  | {
      type: "error";
      code:
        | "invalid_message"
        | "project_busy"
        | "provider_error"
        | "sandbox_unavailable";
    };
```

收到非法帧、超出队列/大小限制或 Provider 故障时，Worker 发送尽力而为的 error frame 并关闭连接。Terminal 输入输出不会写入 D1。

## 10. Preview

| 方法 | 路径 | 鉴权 | 成功响应 | 主要错误 |
| --- | --- | --- | --- | --- |
| `GET` | `/api/projects/:projectId/preview` | 登录 + 所有权 | `200 ProjectPreviewResponse` | `401`、`404`、`500`、`503` |
| `POST` | `/api/projects/:projectId/preview/start` | 登录 + 所有权 + 同源 | `201 ProjectPreviewResponse` | `401`、`403`、`404`、`409`、`500`、`503` |
| `POST` | `/api/projects/:projectId/preview/stop` | 登录 + 所有权 + 同源 | `200 stopped` | `401`、`403`、`404`、`409`、`503` |
| `GET/HEAD` | `/api/projects/:projectId/preview/content/:token/*` | 签名 capability | 上游 Preview Response | `404`、`409`、`500`、`503` |

```ts
type ProjectPreviewResponse = {
  status: "starting" | "running" | "stopped";
  expiresAt: string | null;
  contentUrl: string | null;
};
```

`contentUrl` 只在 `running` 时存在。内容网关：

- 只允许 `GET` 和 `HEAD`。
- 只转发白名单请求头和响应头。
- 不跟随上游重定向；只改写安全的相对 Location。
- 对 HTML 注入同源 base path，移除 Vite HMR client，设置 CSP、`no-store`、`nosniff` 和 `no-referrer`。
- Worker 到固定 Preview 上游的单次 fetch 最长 15 秒。
- token 只绑定 `projectId + previewSessionId + expiresAt`。

## 11. 内部 ModelGateway

```text
POST /api/model-gateway/v1/chat/completions
Authorization: Bearer <short-lived Run capability>
Content-Type: application/json
```

这是沙箱 Agent 使用的窄 OpenAI Chat Completions 兼容面，不是浏览器产品 API：

- capability 必须有效，且 D1 中对应 Run 仍为 `starting` 或 `running`。
- 请求模型必须与 AgentRun 的 `model_id` 一致。
- 请求体最多 4 MiB；即使缺少或伪造 `Content-Length`，Worker 也按实际读取字节数中止。
- Worker 强制输出 token 上限，把平台 Gemini Key 注入上游请求。
- Worker 到 Gemini 的单次上游 POST 最长 120 秒；deadline 到期返回通用
  `504 model_timeout`，且不会自动重放非幂等模型请求。
- 成功上游响应最多缓冲 8 MiB，错误诊断最多读取 64 KiB；超限或非 UTF-8 响应统一拒绝。
- 上游成功响应必须包含 usage；usage 写入 D1 失败时不把未计量结果返回 Agent。
- 响应使用 `cache-control: no-store`。

ModelGateway 使用 OpenAI 风格错误体：

```json
{
  "error": {
    "code": "invalid_api_key",
    "message": "The ModelGateway capability is invalid or expired.",
    "type": "invalid_api_key"
  }
}
```

它不会向 Agent 返回 Gemini Key 或上游原始错误正文。

## 12. 不存在的接口

当前没有以下接口，客户端也不能通过传参模拟这些能力：

- 任意 shell command、任意端口代理、任意 Provider URL。
- Project 文件写入/上传/下载、删除、版本和快照。
- Git commit、checkout、reset、apply patch 或历史查询。
- Runtime 安装、模板选择、Provider sandbox ID 查询。
- Team/成员/分享。
- BYOK、套餐、支付、余额、配额和账单。

限制值和互斥矩阵见 [平台限制与限制对象](./platform-limits.md)。
