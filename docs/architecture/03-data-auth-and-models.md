# 数据、认证、模型与基础用量

> 状态：D1、Better Auth、ModelGateway、Run usage、Terminal/Preview 临时所有权和不落库的 Changes 已实现；2026-07-30 已接入严格脱敏的 Sentry Error Monitoring。当前没有维护者角色或管理视图。
> 关联：[ADR-0002](../adr/0002-run-agent-process-and-lease-lifecycle.md) · [ADR-0003](../adr/0003-agent-run-workflow.md) · [ADR-0005](../adr/0005-controlled-project-terminal.md) · [ADR-0006](../adr/0006-controlled-project-preview.md) · [ADR-0007](../adr/0007-controlled-project-changes.md) · [领域术语](../../CONTEXT.md) · [环境变量](../setup/environment-variables.md)

## 1. 存储与秘密边界

| 位置 | 保存内容 | 不保存内容 |
| --- | --- | --- |
| D1 | Better Auth 表、Project 元数据、用户可见 Message、当前 SandboxLease 状态、AgentRun 状态和聚合 usage，以及当前临时 Terminal/Preview 协调行。 | Project 文件、Git status/diff/history、原始 Agent 事件、终端输入/输出/滚屏、Preview 页面/日志/截图/访问历史、Provider 明文 Key、私有推理。 |
| 沙箱磁盘 | 当前 `/workspace`、Agent 进程、依赖缓存和开发服务。 | 唯一可恢复的长期备份、认证 Secret、Gemini 原始 Key。 |
| Worker Secrets | `GEMINI_API_KEY`、`BETTER_AUTH_SECRET`，以及以后真实运行时所需的 Provider Key。 | 普通业务数据、完整 Project 内容。 |
| Sentry | 严格 allowlist 清洗后的服务端和浏览器错误、stack/debug ID、应用关联 ID 与少量数值上下文。 | prompt、消息正文、代码文件、文件路径、密钥、Provider 引用、原始 Agent/终端流、请求正文、Cookie、用户身份和 breadcrumbs。 |

V1 没有 R2 Binding。Project 文件只在沙箱存活期间存在；沙箱停止或故障后，Project 可以留下元数据和对话，但文件允许丢失。

## 2. 认证与授权

Better Auth 负责 `user`、`account`、`session` 和 `verification`。第一版只启用邮箱密码注册/登录：`emailAndPassword.enabled = true`；不配置 Google OAuth、邮件验证、找回密码或邮件发送服务。

私有 Preview 额外使用部署级邮箱 allowlist。它在 Better Auth 邮箱注册/登录前拒绝未受邀邮箱，并在业务请求解析 Session 后再次校验，避免旧 Session 绕过部署策略。该 allowlist 不创建团队、邀请表或角色模型。

每个业务请求：

1. 从 Better Auth Cookie 取得当前 `user_id`。
2. 任何 Project 查询都按 `WHERE project.id = ? AND project.user_id = ?` 执行。
3. 从 Project 推导 Message、SandboxLease、AgentRun、终端和 preview 的访问权。
4. 创建 AgentRun 时由服务端解析已注册的 `agent_runtime_id` 与 `sandbox_runtime_id`；浏览器提交的任意 Runtime/命令都不可信。
5. 创建 AgentRun 前检查部署级 `RUNS_ENABLED`；关闭时必须先于 Message、Lease 和 AgentRun 写入返回。

必须固定 `BETTER_AUTH_URL` 并设置受信任 origin；React 和 API 同域可避免 CORS 与跨域 Cookie 的复杂度。开放公共注册前，需要重新审阅邮箱验证、注册限流、滥用处理和找回密码。

## 3. D1 目标表

Better Auth 的认证表与应用表由迁移一并维护。新增 Better Auth 插件或自定义字段前，先生成并审阅对应迁移。

| 表 | 关键字段 | 用途 |
| --- | --- | --- |
| `projects` | `id`, `user_id`, `title`, `default_agent_runtime_id`, `created_at`, `updated_at` | 持久 Project 元数据和对话归属。 |
| `messages` | `id`, `project_id`, `agent_run_id`, `sequence`, `role`, `content`, `created_at` | 用户消息和最终 assistant 消息。 |
| `sandbox_leases` | `id`, `project_id`, `sandbox_runtime_id`, `provider_ref`, `status`, `created_at`, `updated_at` | 每个 Project 一条当前逻辑 Lease；`provider_ref` 私有、可覆盖。 |
| `agent_runs` | `id`, `user_id`, `project_id`, `input_message_id`, `sandbox_lease_id`, `agent_runtime_id`, `sandbox_runtime_id`, `model_id`, `status`, `failure_code`, `provider_process_ref`, 用量与时间字段 | 一次 Agent 执行的状态、稳定失败分类、关联、当前私有进程引用和基础计量。 |
| `terminal_sessions` | `id`, `project_id`, `sandbox_lease_id`, `provider_sandbox_ref`, `provider_process_ref`, `expires_at`, `created_at`, `updated_at` | 一个 Project 当前临时 PTY 的硬互斥与私有终止引用；关闭即删除，不是历史表。`expires_at` 只供 Workflow 调度，不能自动解锁。 |
| `preview_sessions` | `id`, `project_id`, `sandbox_lease_id`, `provider_sandbox_ref`, `provider_process_ref`, `status`, `port`, `expires_at`, `created_at`, `updated_at` | 一个 Project 当前临时 Preview 的所有权与私有终止引用；固定端口 3000，停止即删除，不是页面或访问历史。 |

`agent_runs` 的用量字段是：`input_tokens`、`output_tokens`、`total_tokens`、`model_request_count`、`sandbox_duration_ms`。ModelGateway 用原子 delta 累加模型 usage；沙箱时长用幂等 `MAX` 写入，避免 Workflow 重试重复累计。辅助字段为 `created_at`、`started_at`、`finished_at`、`failure_code`。`failure_reason` 只因远程增量迁移暂留为未使用物理列。

数据库需要以下互斥约束：

```sql
CREATE UNIQUE INDEX sandbox_leases_one_per_project
  ON sandbox_leases(project_id);

CREATE UNIQUE INDEX agent_runs_one_active_per_project
  ON agent_runs(project_id)
  WHERE status IN ('queued', 'starting', 'running', 'cancelling');

-- terminal_sessions.project_id 在表定义中声明为 UNIQUE
-- preview_sessions.project_id 在表定义中声明为 UNIQUE

CREATE TRIGGER agent_runs_block_active_terminal
BEFORE INSERT ON agent_runs
WHEN EXISTS (
  SELECT 1 FROM terminal_sessions
  WHERE project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'project_terminal_active');
END;

CREATE TRIGGER agent_runs_block_starting_preview
BEFORE INSERT ON agent_runs
WHEN EXISTS (
  SELECT 1 FROM preview_sessions
  WHERE project_id = NEW.project_id AND status = 'starting'
)
BEGIN
  SELECT RAISE(ABORT, 'project_preview_starting');
END;
```

`preview_sessions.status='starting'` 只覆盖启动竞态；进入 `running` 后允许后续 AgentRun 和 Terminal 复用同一沙箱。停止沙箱与 idle cleanup 则必须检查任意活动 Preview。`expires_at` 只供 durable Workflow 调度，不能仅因墙钟经过就把私有进程当作已经停止。

不建立 `workspace_revisions`、Git changes/history、`usage_events`、`usage_reservations`、`model_connections`、`credential_leases` 或 `audit_events`。Changes 每次直接读取当前沙箱 Git working tree/index，不新增 D1 表或迁移。本项目处于个人开发阶段，迁移重建可以清洗本地 D1 数据，不需要兼容这些旧表。

## 4. 平台 Gemini 与 ModelGateway

- `GEMINI_API_KEY` 只存在 Worker Secret 或本地 `.dev.vars`，不写入 AgentRuntime 配置、浏览器响应、D1 或沙箱环境。
- Worker 的 `ModelGateway` 代表当前用户调用 Gemini，并从实际 API 响应提取 token 与请求数，累加到对应 `agent_runs` 行。
- 单次 Gemini POST 最长 120 秒，deadline 到期使用固定诊断码并返回通用错误；网关不自动重试非幂等模型请求。
- Agent 只使用 Run 范围内的受限访问路径；它不知道 Gemini 原始 Key，也不拥有永久模型凭据。
- 默认模型 ID 是服务端配置。第一版不提供模型选择 UI、BYOK 或用户上传模型连接。

短时能力令牌、Agent custom provider 与 `AgentRunWorkflow` 的协调关系由 [ADR-0003](../adr/0003-agent-run-workflow.md) 定义。真实 E2B + Pi/Goose + Gemini 和 Cloudflare 远程 Workflow 均已完成代表性验收；两种 Runtime 复用同一网关，沙箱没有 Gemini Key。公开 Goose 前仍需复核 capability 的工具继承与输出脱敏；复杂任务下的免费层 CPU/subrequest 上限也需持续观察。

BYOK 是一个单独的未来能力。实施时需要另行决定用户 Key 的加密、撤销、网关访问、审计和泄漏响应，不能把它伪装成当前字段或环境变量。

## 5. 用量与管理，不是计费

Project Inspector 显示所选 Run 的真实聚合值；fake Runtime 的 token 与模型请求仍为零。认证后的 `GET /api/usage` 与 Usage 页面已经实现，直接按当前 `user_id` 聚合全部现存 `agent_runs`，返回：

- `totals`：Run 数、输入/输出/总 token、模型请求数和沙箱时长；
- `projects`：按 Project 分组的同一组指标；
- `agentRuntimes`：按 AgentRuntime 分组的同一组指标；
- `scope: "all_time"`：当前版本没有日期筛选或时间序列。

聚合不按 Run 状态过滤。取消、失败、超时或仍在执行的 Run 只要已有真实落库用量，就计入当前读数。前端只显示 API 数据，不推算价格；实现没有新增迁移、`usage_events`、外部依赖或环境变量。内部管理视图仍未实现。

`AgentRun` 是 V1 的计量单位，不是单次模型调用。一个 Run 可包含多次模型请求和工具调用；终态时，平台记录该次总 token、模型请求数和沙箱执行时长。临时 Terminal 和 Preview 不生成 AgentRun，也不写长期 usage；其成本只由各自 30 分钟上限、E2B timeout 和停止后的 10 分钟 idle cleanup 约束。

用量用于：

- 让用户看见自己的基础消耗；
- 让项目维护者按用户、Project、日期聚合真实数据；
- 后续接入支付前验证成本模型；
- 在实现配额前提供最小的异常观察基础。

它不用于保存价格、套餐、信用余额、订单、发票或付款。需要强配额、预留或商用计费时，必须作为新的领域设计引入，而不是提前保留半套表。

## 6. 脱敏错误观测：Sentry

当前代码通过 `DiagnosticReporter` 输出受控结构化事件，使用 `requestId` 关联一次 Worker invocation，使用现有 `runId` 关联跨请求、Workflow、ModelGateway、取消和 idle cleanup 的完整业务执行。D1 不保存 trace event，也不新增重复的持久化 `trace_id`。

Preview 已将 Sentry 接为 `DiagnosticReporter` 的外层 adapter，并覆盖 Hono 未捕获异常、
Cloudflare Workflow 和 React Error Boundary。服务端读取 `SENTRY_DSN` 与
`SENTRY_ENVIRONMENT`；浏览器构建读取 `VITE_SENTRY_DSN` 与
`VITE_SENTRY_ENVIRONMENT`。DSN 缺失或 Reporter 上报失败时，产品执行和结构化
console 仍然继续，因此 Sentry 不是运行可用性前提。

两端 `beforeSend` 都采用 allowlist 重建事件，而不是仅删除几个已知字段。当前只启用
Error Monitoring，保留异常类型、stack、release/debug metadata、固定环境、受控
diagnostic tags 和 `requestId`/`runId` 等应用关联字段；原始 message 会被通用文案替代。
Logs、Tracing、Metrics、Replay、breadcrumbs、自动 user/request context 和默认
integration 内容采集全部关闭。

Preview 发布时由 Vite 插件上传 Worker 与 React 的隐藏源码映射，上传完成后删除
`dist` 中的 `.map`。上传 token 只存在于本地忽略文件，不进入 Worker Secret、浏览器或
Git。源码映射用于还原 stack，不改变前述数据清洗边界。

## 7. 非目标

- R2、快照、文件恢复、版本树或长期原始执行审计。
- 团队、组织、租户、成员角色和邀请。
- `plans`、`subscriptions`、`prices`、`invoices`、`payments` 表或 API。
- 将真实 Provider Key、E2B sandbox ID、Container ID 或 Gemini Key 返回给前端。
- 将未注册的 AgentRuntime 或任意 CLI 命令持久化为 User 可选项。

## 8. 外部依据

- [Better Auth 安装与环境变量](https://better-auth.com/docs/installation) 和 [邮箱密码登录](https://better-auth.com/docs/authentication/email-password)
- [Gemini API Key 指南](https://ai.google.dev/gemini-api/docs/api-key)
- [Cloudflare D1 Binding](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Sentry Cloudflare SDK](https://github.com/getsentry/sentry-javascript/blob/develop/packages/cloudflare/README.md)
- [Sentry Hono SDK](https://github.com/getsentry/sentry-javascript/blob/develop/packages/hono/README.md)
- [Sentry JavaScript Source Maps](https://docs.sentry.io/platforms/javascript/guides/cloudflare/sourcemaps/)
