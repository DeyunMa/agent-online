# ADR-0008：分层错误语义并以 requestId/runId 关联执行

- 状态：Accepted；P0 与 2026-07-30 Sentry 外层 adapter 修订已实现
- 日期：2026-07-27
- 关联：[ADR-0003](./0003-agent-run-workflow.md) · [数据与模型](../architecture/03-data-auth-and-models.md) · [原始路线提案](../proposals/observability-errors-and-optimization-roadmap.md)

## 背景

一个 AgentRun 会经过创建 HTTP 请求、Cloudflare Workflow、Sandbox/Agent 进程、多个
ModelGateway 请求、取消请求和 idle cleanup。单个 Worker invocation 的 `requestId`
无法关联完整执行，而再持久化一个与 `AgentRun.id` 重复的 `trace_id` 也不能自动形成
跨 invocation 的平台 trace。

原实现同时存在以下问题：

- 普通产品 API 在多个路由自行维护 `{ error, requestId }` 和 HTTP status；
- `agent_runs.failure_reason` 保存受控但不稳定的自由文本；
- 多数 catch 只收敛 D1 状态，没有固定的失败阶段和内部诊断分类；
- 少量 `console.error` 各自使用不同结构。

项目仍坚持个人开源产品边界：不为观测增加第二个 Worker、D1 event 表、R2、raw
transcript 或外部日志依赖。

## 决策

### 1. 使用两级关联身份

- `requestId`：Worker 为每次 HTTP/WebSocket upgrade invocation 生成，只进入响应头、
  普通错误体和本次 invocation 的结构化事件。
- `runId`：直接使用现有 `AgentRun.id`，关联创建、Workflow、Sandbox、Agent、
  ModelGateway、取消、终态和 Run idle cleanup。
- Terminal/Preview 分别使用现有 `terminalSessionId`、`previewSessionId`。
- 不新增持久化 `trace_id`，不信任浏览器或沙箱传入的 request/trace header。

Cloudflare 平台 trace 将来只能作为单次 invocation 的辅助耗时视图；跨 invocation
查询以结构化日志中的 `runId` 为主线。

### 2. 错误语义分成四层

| 层级 | 例子 | 所有者 |
| --- | --- | --- |
| Application outcome | `{ kind: "project_busy" }` | application 用例 |
| Public API error | `project.busy` | HTTP adapter 和 Shared DTO |
| Persisted Run failure | `run.agent_process_failed` | AgentRun 生命周期 |
| Diagnostic error | `AGENT_PROCESS_FAILED` | application/adapter 观测接缝 |

预期业务拒绝继续使用 discriminated union，不建立可从任意层抛出的全能 `AppError`。
Provider 原始异常只作为瞬时 cause，不进入浏览器、D1 或普通结构化事件。

### 3. 普通产品 API 使用唯一错误 renderer

`src/server/http/api-errors.ts` 唯一维护 public code 到 HTTP status 和 `retryable` 的映射：

```json
{
  "error": {
    "code": "project.busy",
    "retryable": true
  },
  "requestId": "request-id"
}
```

客户端只按 `code` 本地化文案，不解析 message。`retryable=true` 只允许人工重试，不
允许自动重放非幂等 POST。

Better Auth、Terminal WebSocket、Preview 内容代理和 ModelGateway 是不同传输协议，
保留各自 envelope，但底层失败必须显式映射为 diagnostic code。

### 4. AgentRun 持久化稳定 failure code

`agent_runs.failure_code` 只允许以下值：

- `run.start_failed`
- `run.sandbox_failed`
- `run.agent_protocol_failed`
- `run.agent_process_failed`
- `run.model_failed`
- `run.no_visible_reply`
- `run.timed_out`
- `run.interrupted`
- `run.internal_failed`

D1 insert/update trigger 强制 status 组合：

- 非终态、`succeeded`、`cancelled` 必须为 `NULL`；
- `timed_out` 和 `interrupted` 使用各自固定 code；
- `failed` 必须使用其余失败 code。

`0007` 使用增量迁移处理已存在 Preview 数据。旧 `failure_reason` 物理列暂时保留，但
产品代码不再读取，并在状态迁移时清空；以后只有在单独批准远程 destructive
migration 后才删除。

### 5. 结构化观测使用窄 Reporter 接口

`src/observability/contract.ts` 定义固定 event、stage、diagnostic code 和安全字段；
application 只依赖 `DiagnosticReporter`。当前
`src/server/observability/structured-reporter.ts` adapter 把事件写为结构化 console
对象，不增加 npm SDK、环境变量或外部服务。

允许字段包括关联 ID、Runtime/Model ID、Run status/failureCode、聚合 usage、固定
upstream category/status 和 duration。禁止字段包括：

- prompt、Message/Agent 输出、文件内容和文件路径；
- Cookie、Authorization、capability、环境变量和任何 Key；
- Provider sandbox/process reference、内部 host/port；
- 原始 `error.message`、Provider response body 和普通事件中的 stack。

Reporter 自身失败不得改变产品执行。D1 不保存 diagnostic event、span 或日志。

诊断事件采用至少一次语义：Workflow 重试、取消与原执行收敛竞争时，可能出现相同
`event + runId` 的重复记录。日志消费者不能把事件条数当业务计数，也不能依赖全局严格
顺序；Run 的最终状态、failure code 和 usage 仍以 D1 为准。当前结构化日志是诊断线索，
不是审计账本。

### 6. 第一阶段事件保持稀疏

当前只记录：

- Run created、dispatch failed、execution started/finished、stage failed、cancel requested；
- ModelGateway capability/upstream/response/usage failure；
- Run idle cleanup success/failure；
- Preview start failure；
- 未捕获 HTTP request failure。

成功模型请求已由 D1 usage 覆盖，不额外逐请求写成功日志。

## 未采用方案

| 方案 | 原因 |
| --- | --- |
| 每个 Run 新增 `trace_id` | 与 Run ID 重复，不能形成真实跨 invocation span tree。 |
| D1 保存所有 event/span | 产生写放大、保留与隐私责任，不符合轻量边界。 |
| 直接返回 Provider message | 可能泄露正文、内部标识、路径或凭据。 |
| 所有失败统一抛 `AppError` | 会把 Domain、Provider、HTTP 和持久化语义重新耦合。 |
| 立即接入 Sentry/OTel | 当前原生结构化日志足够，先验证真实需求。 |

## 后果

- 普通产品 API 是一次有意的内部合同升级；当前项目不兼容旧浏览器 bundle。
- Run 失败可以稳定聚合和本地化，不再依赖英文自由文本。
- 通过一个 `runId` 可以查询跨 invocation 的受控执行时间线。
- Domain 保持无日志依赖；观测实现位于外层 adapter。
- 当前没有告警、长周期日志保留或完整分布式 trace tree，这些仍是明确 deferred。

## 验收

1. public code 目录与 HTTP/retryable registry 一一对应。
2. 每个普通错误响应 header/body 使用同一 `requestId`。
3. D1 拒绝 status/failureCode 非法组合。
4. 创建、Workflow、模型失败、取消和 idle cleanup 事件能携带正确 `runId`。
5. 诊断事件和响应不包含用户内容、Provider reference、Key 或原始异常。
6. import boundary、typecheck、单元/D1/browser 测试和 production build 全部通过。
7. 远程迁移、trace 配置和部署仍需单独批准。

## 2026-07-30 修订：接入 Sentry Error Monitoring

用户在稳定错误合同、结构化日志和脱敏测试已经成立后批准接入 Sentry。该变更修订
“立即接入 Sentry/OTel”这一历史未采用项，但不改变本 ADR 的分层和关联决策：

1. Sentry 是 `DiagnosticReporter` 的可选外层 adapter，结构化 console 继续保留。
2. Hono 未捕获异常、Cloudflare Workflow 和 React Error Boundary 使用官方 SDK；
   `requestId` 与 `runId` 仍是应用关联根，不伪造跨 invocation span tree。
3. 两端 `beforeSend` 以 allowlist 重建事件，只允许 stack/debug metadata、固定环境和
   release、受控诊断标签、应用关联 ID 与数值上下文。
4. Logs、Tracing、Metrics、Replay、breadcrumbs、自动 user/request context 和原始异常
   正文关闭；prompt、消息、文件、终端流、Provider 引用和 Key 仍禁止进入事件。
5. DSN 缺失、SDK 网络失败或 Reporter 抛错不能改变产品结果。
6. Preview 发布上传 Worker/React 隐藏源码映射，上传凭据只在本地构建环境中存在，
   上传后删除部署产物中的 `.map`。

本修订只增加错误可观测性，不新增 D1 事件表、R2、第二个 Worker、持久 `trace_id` 或
完整分布式 tracing。
