# 数据、认证、模型与基础用量

> 状态：D1、Better Auth、ModelGateway 与 Run 聚合 usage 已接通；用户/管理聚合视图待实现。
> 关联：[ADR-0002](../adr/0002-run-agent-process-and-lease-lifecycle.md) · [ADR-0003](../adr/0003-agent-run-workflow.md) · [领域术语](../../CONTEXT.md) · [环境变量](../setup/environment-variables.md)

## 1. 存储与秘密边界

| 位置 | 保存内容 | 不保存内容 |
| --- | --- | --- |
| D1 | Better Auth 表、Project 元数据、用户可见 Message、当前 SandboxLease 状态、AgentRun 状态和聚合 usage。 | Project 文件、原始 Agent 事件、完整终端日志、Provider 明文 Key、私有推理。 |
| 沙箱磁盘 | 当前 `/workspace`、Agent 进程、依赖缓存和开发服务。 | 唯一可恢复的长期备份、认证 Secret、Gemini 原始 Key。 |
| Worker Secrets | `GEMINI_API_KEY`、`BETTER_AUTH_SECRET`，以及以后真实运行时所需的 Provider Key。 | 普通业务数据、完整 Project 内容。 |
| 可选 Sentry | 脱敏错误和稀疏的服务端追踪元数据。 | prompt、消息正文、代码文件、密钥、原始 Agent/终端流。 |

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
6. 内部管理端点以后以独立的 `ADMIN_EMAILS` Worker allowlist 保护，不为此预建角色、组织或团队模型。

必须固定 `BETTER_AUTH_URL` 并设置受信任 origin；React 和 API 同域可避免 CORS 与跨域 Cookie 的复杂度。开放公共注册前，需要重新审阅邮箱验证、注册限流、滥用处理和找回密码。

## 3. D1 目标表

Better Auth 的认证表与应用表由迁移一并维护。新增 Better Auth 插件或自定义字段前，先生成并审阅对应迁移。

| 表 | 关键字段 | 用途 |
| --- | --- | --- |
| `projects` | `id`, `user_id`, `title`, `default_agent_runtime_id`, `created_at`, `updated_at` | 持久 Project 元数据和对话归属。 |
| `messages` | `id`, `project_id`, `agent_run_id`, `sequence`, `role`, `content`, `created_at` | 用户消息和最终 assistant 消息。 |
| `sandbox_leases` | `id`, `project_id`, `sandbox_runtime_id`, `provider_ref`, `status`, `created_at`, `updated_at` | 每个 Project 一条当前逻辑 Lease；`provider_ref` 私有、可覆盖。 |
| `agent_runs` | `id`, `user_id`, `project_id`, `input_message_id`, `sandbox_lease_id`, `agent_runtime_id`, `sandbox_runtime_id`, `model_id`, `status`, `provider_process_ref`, 用量与时间字段 | 一次 Agent 执行的状态、关联、当前私有进程引用和基础计量。 |

`agent_runs` 的用量字段是：`input_tokens`、`output_tokens`、`total_tokens`、`model_request_count`、`sandbox_duration_ms`。ModelGateway 用原子 delta 累加模型 usage；沙箱时长用幂等 `MAX` 写入，避免 Workflow 重试重复累计。辅助字段为 `created_at`、`started_at`、`finished_at`、`failure_reason`。

数据库需要两个约束：

```sql
CREATE UNIQUE INDEX sandbox_leases_one_per_project
  ON sandbox_leases(project_id);

CREATE UNIQUE INDEX agent_runs_one_active_per_project
  ON agent_runs(project_id)
  WHERE status IN ('queued', 'starting', 'running', 'cancelling');
```

不建立 `workspace_revisions`、`usage_events`、`usage_reservations`、`model_connections`、`credential_leases` 或 `audit_events`。本项目处于个人开发阶段，迁移重建可以清洗本地 D1 数据，不需要兼容这些旧表。

## 4. 平台 Gemini 与 ModelGateway

- `GEMINI_API_KEY` 只存在 Worker Secret 或本地 `.dev.vars`，不写入 AgentRuntime 配置、浏览器响应、D1 或沙箱环境。
- Worker 的 `ModelGateway` 代表当前用户调用 Gemini，并从实际 API 响应提取 token 与请求数，累加到对应 `agent_runs` 行。
- Agent 只使用 Run 范围内的受限访问路径；它不知道 Gemini 原始 Key，也不拥有永久模型凭据。
- 默认模型 ID 是服务端配置。第一版不提供模型选择 UI、BYOK 或用户上传模型连接。

短时能力令牌、Pi custom provider 与 `AgentRunWorkflow` 的协调关系由 [ADR-0003](../adr/0003-agent-run-workflow.md) 定义。真实 E2B + Pi + Gemini spike 已验证协议可行性；Cloudflare 远程 Workflow 仍需预览环境验收。

BYOK 是一个单独的未来能力。实施时需要另行决定用户 Key 的加密、撤销、网关访问、审计和泄漏响应，不能把它伪装成当前字段或环境变量。

## 5. 用量与管理，不是计费

Project Inspector 可以显示所选 Run 的真实聚合值；fake Runtime 的值仍为零。跨 Run 的用户用量页与内部管理视图尚未实现。

`AgentRun` 是 V1 的计量单位，不是单次模型调用。一个 Run 可包含多次模型请求和工具调用；终态时，平台记录该次总 token、模型请求数和沙箱执行时长。

用量用于：

- 让用户看见自己的基础消耗；
- 让项目维护者按用户、Project、日期聚合真实数据；
- 后续接入支付前验证成本模型；
- 在实现配额前提供最小的异常观察基础。

它不用于保存价格、套餐、信用余额、订单、发票或付款。需要强配额、预留或商用计费时，必须作为新的领域设计引入，而不是提前保留半套表。

## 6. 可选观测：Sentry

Sentry 不是运行依赖，也不应接收用户内容。真实 Worker、ModelGateway 和 SandboxRuntime 接入后，可以只接入错误监控和低采样服务端 trace，标签使用 `agent_run_id`、Runtime 种类和状态等无敏感元数据。

第一版不要启用 Session Replay、日志全量导出或 AI Agent transcript 追踪；这些能力更容易意外收集 prompt、文件或终端输出。接入前应明确 `beforeSend`/数据清洗策略、采样率和错误阈值。

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
- [Sentry for Hono on Cloudflare](https://docs.sentry.io/platforms/javascript/guides/cloudflare/frameworks/hono/)
