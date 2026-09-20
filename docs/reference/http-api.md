# HTTP、SSE 与 WebSocket 接口设计

> 文档状态：当前公开接口基准
>
> 校准日期：2026-07-30
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
  单文件上传使用独立的 4 MiB 文件上限和 64 KiB multipart 开销余量。Better Auth
  与 ModelGateway 使用各自协议，不经过该产品 guard。

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
| `request.too_large` | `413` | false | 普通产品请求体或文件上传请求体超过对应上限。 |
| `request.invalid` | `400` | false | JSON 或字段不合法。 |
| `resource.limited` | `429` | true | 当前用户跨 Project 并发或启动频率额度耗尽。 |
| `resource.not_found` | `404` | false | 路由或所有权过滤后的资源不存在。 |
| `project.busy` | `409` | true | 当前 Run、Terminal 或 Preview 启动占用 Project。 |
| `run.creation_disabled` | `503` | false | 维护者关闭了新 Run。 |
| `agent_runtime.unavailable` | `409` | false | Runtime 未公开或未启用。 |
| `sandbox.not_active` | `409` | false | Project 当前没有可附着的沙箱。 |
| `sandbox.provider_unavailable` | `503` | true | Sandbox Provider 调用失败。 |
| `project_path.not_found` | `404` | false | 文件或 Changes 路径不存在。 |
| `project_path.unsupported` | `400` | false | 路径超出受控范围。 |
| `file.too_large` | `413` | false | 文件超过读取上限。 |
| `file.already_exists` | `409` | false | 上传目标已存在，不允许覆盖。 |
| `file.content_unsupported` | `415` | false | 不是可公开的 UTF-8 文本。 |
| `preview.entry_missing` | `409` | false | `/workspace` 没有可预览的根 `index.html`。 |
| `preview.dependencies_missing` | `409` | false | 项目声明了依赖但根 `node_modules` 不存在。 |
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

`src/shared/api.ts` 用 Zod 定义普通产品请求、公开响应和 Run SSE 事件，TypeScript
类型从 schema 推导。Hono 的 JSON mutation 在同源、大小限制和鉴权之后通过
`@hono/zod-validator` 校验；非法 JSON 与字段错误统一返回 `request.invalid`，不公开
Zod 的输入或错误细节。浏览器 API 对成功响应、错误体和生命周期事件执行运行时校验，
无法识别的 HTTP 响应显示通用错误，非法 SSE 事件被忽略。

Schema 会移除未知字段；服务端仍须通过独立 DTO 显式选择公开字段，并单独检查所有权，
不能把客户端校验当作私有数据保护。客户端只引用 Shared，不导入 Server 路由类型。

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
| `GET` | `/api/capabilities` | 无 | `200 PlatformCapabilitiesResponse` | 返回当前公开 AgentRuntime 和 Changes/Terminal/Preview/Run/File upload 开关；Files 读取还由现有 Lease/Runtime 状态决定。 |
| `GET/POST` | `/api/auth/*` | Better Auth | Better Auth 标准响应 | 邮箱密码注册、登录、会话和退出。 |

能力响应：

```ts
type PlatformCapabilitiesResponse = {
  agentRuntimeIds: Array<"pi" | "goose" | "claude-code" | "codex-cli">;
  defaultAgentRuntimeId: "pi" | "goose" | "claude-code" | "codex-cli";
  runCreationEnabled: boolean;
  changesEnabled: boolean;
  fileUploadEnabled: boolean;
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
| `GET` | `/api/projects` | 可选 `cursor` | `200 ProjectPageResponse` | `401` |
| `POST` | `/api/projects` | `{ "title": string }` | `201 ProjectResponse` | `400`、`401` |
| `GET` | `/api/projects/:projectId` | 无 | `200 ProjectResponse` | `401`、`404` |
| `PATCH` | `/api/projects/:projectId` | `{ "title": string }` | `200 ProjectResponse` | `400`、`401`、`404` |
| `DELETE` | `/api/projects/:projectId` | 无 | `204` | `401`、`404`、`409`、`503` |
| `GET` | `/api/projects/:projectId/messages` | 可选 `before` 或 `after` | `200 MessagePageResponse` | `401`、`404` |
| `POST` | `/api/projects/:projectId/sandbox/stop` | 无 | `200 ProjectResponse` | `401`、`404`、`409`、`503` |

行为说明：

- 新 Project 的 `defaultAgentRuntimeId` 固定为 `pi`。
- Project 列表按 `updated_at DESC, id DESC` 游标分页，每页 50 条，返回 items/nextCursor。
- Message 默认读取最新 50 条；before 读取历史、after 增量同步，items 始终按 sequence ASC 返回。
- Rename 与 Create 共用 trim 后 1 至 120 字符的标题合同；标题变化会 touch
  `updated_at`，相同标题不写 D1。
- Delete 是不可恢复的硬删除。活动 Run、Terminal 或 Preview 返回
  `409 project.busy`；空闲 Provider sandbox 先停止，再在同一 D1 batch 中归档最小
  per-Run usage 并级联删除 Project、Message、AgentRun 和 Lease。Provider 停止失败、
  归档失败或 Lease 冲突时保留 Project。
- 手动停止先以 D1 条件更新脱离 Provider 引用，再调用 Provider；活动 Run、Terminal 或 Preview 会阻止停止。
- 当前没有 Project 分享或成员接口。

## 5. AgentRun

| 方法 | 路径 | 请求 | 成功响应 | 主要错误 |
| --- | --- | --- | --- | --- |
| `POST` | `/api/projects/:projectId/agent-runs` | `{ "content": string, "agentRuntimeId"?: string }` | `201 AgentRunResponse` | `400`、`401`、`404`、`409`、`503` |
| `GET` | `/api/projects/:projectId/agent-runs` | 可选 `cursor` | `200 AgentRunPageResponse` | `401`、`404` |
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
- Worker 初始每 750 ms 从 D1 读取 Run；状态不变时按 1,500、3,000、5,000 ms
  退避，状态变化时发送新的 `run.status` 并恢复 750 ms。稳定状态下的终态检测
  最多等待约 5 秒加 D1 请求耗时。
- 每 15 秒发送 SSE comment 心跳；心跳不读取 D1、不占用 `sequence`。
- 进入终态后发送一次 `run.completed` 并结束流。
- 客户端断开时立即清除等待计时器、停止后续 D1 轮询并丢弃在途查询结果；SSE
  不是后台执行所有者。
- 最终 assistant 回复不通过 SSE 发送，浏览器随后刷新 Message API。

SSE 不是可重放事件日志：没有持久 event ID，也不保存 raw Agent 输出。

## 6. Files

| 方法 | 路径 | 查询参数 | 成功响应 | 主要错误 |
| --- | --- | --- | --- | --- |
| `GET` | `/api/projects/:projectId/files` | `path` 可选；空值表示 `/workspace` | `200 ProjectDirectoryResponse` | `400`、`401`、`404`、`409`、`503` |
| `POST` | `/api/projects/:projectId/files` | `multipart/form-data`，唯一字段 `file` | `201 ProjectFileUploadResponse` | `400`、`401`、`404`、`409`、`413`、`503` |
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

type ProjectFileUploadResponse = {
  name: string;
  path: string;
  size: number;
};
```

Files 只附着现有且可读取的 Lease，不会为了浏览或上传创建新沙箱。上传只接受一个
最大 4 MiB 的文件，写入 `/workspace` 根目录且不覆盖同名路径；它不创建 D1/R2
副本、Message 或 AgentRun。路径、大小、文本类型和互斥限制见
[平台限制](./platform-limits.md)。

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
    projectDeleted: boolean;
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

该接口合并现存 AgentRun 和已删除 Project 的最小 Run usage 归档。
`projectDeleted=true` 的 Project 只用于历史分组，客户端不得链接到已删除资源。该接口
是运行事实聚合，不是账单、余额或配额接口。

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
        | "resource_limited"
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

- `start` 在申请临时所有权前检查 Web 入口和常规依赖状态；前置条件错误使用上述稳定
  `409` code。
- 只允许 `GET` 和 `HEAD`。
- 只转发白名单请求头和响应头。
- 不跟随上游重定向；只改写安全的相对 Location。
- 对 HTML 注入同源 base path，移除 Vite HMR client，设置 CSP、`no-store`、`nosniff` 和 `no-referrer`。
- 内容 CSP 设置 `sandbox allow-scripts`；iframe 和直接打开内容 URL 都不能访问平台
  Cookie、localStorage 或同源父页面 DOM。
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

## 分页合同（2026-09-20，本地实现）

Project、Message、Run 列表统一返回 `{ items, nextCursor }`，每页最多 50 条。
这替换旧数组响应，不保留兼容模式；本地应用、测试和部署产物需一起更新。

- `GET /api/projects?cursor=...`：按 `updated_at DESC, id DESC`；cursor 为 URL 编码的
  JSON `{ "at": "ISO timestamp", "id": "application id" }`。列表在更新期间为实时视图，
  前端按 ID 去重，刷新重新查询各页，不承诺跨请求数据库快照。
- `GET /api/projects/:id/agent-runs?cursor=...`：同形游标，按 `created_at DESC, id DESC`；
  不再仅提供最新 50 条，nextCursor 可继续读取更早 Run。
- `GET /api/projects/:id/messages`：默认最近 50 条，items 始终按 sequence 升序；
  nextCursor 是向前加载的 before 值。`?before=N` 读取更早消息。
- `?after=N` 读取严格晚于 N 的最多 50 条消息；此模式 nextCursor 为继续向后的 after 值。
  before/after 不能同时使用。客户端连续补齐新增页，并保留用户主动加载的历史。
- nextCursor 为 null 表示本方向已无下一页。不接收客户端自定页大小或未知查询参数；
  非法游标、负数或冲突方向统一为 `400 request.invalid`。
- 每次请求独立认证和授权，游标仅是排序边界，不赋予资源访问权限。

## 用户资源准入（2026-09-20，本地实现）

创建 Run 与打开 Terminal 共用用户级并发和小时启动额度，规则见
[ADR-0012](../adr/0012-user-resource-admission.md)。拒绝创建 Run 时返回 429
resource.limited，不新增输入 Message；Terminal 已升级连接时返回 resource_limited
控制消息并关闭。模型请求超限返回 OpenAI 风格 429 resource_limit，不向 Gemini 转发。
准入基础设施异常返回 503 admission_unavailable。此模型错误合同独立于普通产品 API。
