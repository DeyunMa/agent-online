# 数据、认证、模型与用户级配额

> 状态：架构基线 v0.2
> 关联：[领域术语](../../CONTEXT.md) · [系统总览](./01-system-overview.md) · [环境变量](../setup/environment-variables.md)

## 1. 存储边界

| 存储 | 保存内容 | 不保存内容 |
| --- | --- | --- |
| D1 | Better Auth 表、Project 元数据、消息、Lease、Run、Revision 指针、用量、预留、模型连接元数据和审计。 | 完整文件树、大型终端日志、Provider 明文 Key。 |
| R2 | 不可变工作区 Revision、manifest、Run 事件归档、构建产物。 | 公开可枚举的用户对象、唯一授权判断、Provider Key。 |
| Worker Secrets | 平台 Gemini Key、认证 Secret、以后 BYOK 加密根密钥。 | 普通业务数据、完整项目内容。 |
| 沙箱磁盘 | 当前 Lease 的 `/workspace`、Pi 进程、临时缓存和开发服务。 | 持久项目唯一副本、认证/模型原始 Key。 |

## 2. 认证与授权

Better Auth 负责 `user`、`account` 和 `session`。第一版只启用邮箱密码注册/登录：`emailAndPassword.enabled = true`；不配置 Google OAuth、邮件验证、找回密码或邮件发送服务。

这意味着第一版适合个人开发和受控测试。开放公共注册前，必须重新审阅邮箱验证、注册限流、滥用处理和找回密码；Better Auth 的默认密码哈希是有意提高计算成本的 `scrypt`，也需要在目标 Workers 配额下做真实验证。

每个业务请求：

1. 从 Better Auth Cookie 取得当前 `user_id`。
2. 任何项目查询都按 `WHERE project.id = ? AND project.user_id = ?` 执行。
3. 从 Project 再导出 Lease、Run、Message、Revision 和 preview 的访问权。
4. 用户级 QuotaPolicy 和 UsageEvent 也以该 `user_id` 查询。

必须固定 `BETTER_AUTH_URL` 并设置受信任 origin；前端和 API 同域可避免 CORS 与跨域 Cookie 的复杂度。

## 3. D1 表

Better Auth 定义自己的认证表；本仓库把其当前的四张核心表（`user`、`session`、`account`、`verification`）与应用表一并维护在 D1 迁移中。新增 Better Auth 插件或自定义字段前，必须先生成并审阅新的迁移：

| 表 | 关键字段 | 用途 |
| --- | --- | --- |
| `projects` | `id`, `user_id`, `title`, `latest_revision_id`, `active_sandbox_lease_id` | 持久项目和单活动 Lease 约束。 |
| `messages` | `id`, `project_id`, `sequence`, `role`, `content`, `run_id` | 项目内对话历史。 |
| `sandbox_leases` | `id`, `project_id`, `runtime_kind`, `provider_ref`, `status`, `started_at`, `idle_expires_at` | 应用拥有的沙箱生命周期记录；`provider_ref` 私有。 |
| `runs` | `id`, `user_id`, `project_id`, `sandbox_lease_id`, `base_revision_id`, `model_connection_id`, `status` | 一次 Pi 任务。 |
| `workspace_revisions` | `id`, `project_id`, `parent_id`, `r2_manifest_key`, `r2_archive_key`, `reason` | 不可变项目版本。 |
| `model_connections` | `id`, `user_id`, `provider`, `model_id`, `mode`, `encrypted_secret`, `key_version`, `fingerprint`, `status` | 平台模型显示与 BYOK 元数据。 |
| `credential_leases` | `id`, `run_id`, `connection_id`, `token_hash`, `expires_at`, `revoked_at`, `max_requests` | 模型网关的短时、可撤销授权。 |
| `usage_reservations` | `id`, `user_id`, `run_id`, `meter`, `reserved_quantity`, `state` | 启动前的资源预算预留。 |
| `usage_events` | `id`, `user_id`, `project_id`, `run_id`, `meter`, `quantity`, `source`, `idempotency_key` | 不可变实际用量。 |
| `audit_events` | `id`, `user_id`, `action`, `target`, `metadata` | 安全与调试追溯。 |

`projects.active_sandbox_lease_id` 只能由 `RunCoordinator` / 项目级协调器写入。它是“每个 Project 最多一个活动 Lease”的并发锁，不允许浏览器直接修改。

## 4. R2 对象布局

```text
users/{userId}/projects/{projectId}/revisions/{revisionId}/manifest.json
users/{userId}/projects/{projectId}/revisions/{revisionId}/workspace.tar.zst
users/{userId}/projects/{projectId}/runs/{runId}/events.ndjson
users/{userId}/projects/{projectId}/runs/{runId}/artifacts/{artifactId}
```

提交顺序：先写唯一 R2 对象，校验完成后再用 D1 事务插入 `workspace_revisions` 并更新 `projects.latest_revision_id`。事务失败时对象成为可清理孤儿；已提交的 Revision 永不指向不存在对象。

## 5. 默认 Gemini 与 BYOK

### 平台 Gemini

- `GEMINI_API_KEY` 只保存在 Worker Secret / 本地 `.dev.vars`，不写入 Pi 配置或沙箱环境。
- 平台模型是 `ModelConnection(mode = platform)`，用户选择的是逻辑模型 ID，不是 Key。
- Worker `ModelGateway` 代表用户调用 Gemini，并记录 token、请求数和失败情况。

### BYOK

BYOK 是后续用户功能，但数据边界在第一版保留：

1. 用户通过认证 API 提交 Key；服务端仅在内存中处理。
2. D1 保存 Provider、模型、密文、nonce、key version 和不可逆指纹。
3. BYOK 加密根密钥保存在 Worker Secret，使用版本化 AEAD 加密；不把明文返回给浏览器。
4. 每个 Run 获取随机生成的短时 `CredentialLease`；D1 只保存 token 哈希，Pi 用原始一次性 token 调用 ModelGateway。
5. Run 结束、取消、超时或超额时，立即撤销该 Lease。

令牌查询、过期、请求上限和撤销都由 D1 管理，因此第一版不需要额外的模型租约签名 Secret。启用 BYOK 前仍必须验证 Pi 流式兼容、租约过期、取消、日志脱敏和出网限制。

## 6. 计量与配额，不是计费

第一版不保存价格、套餐、支付或订单数据。只实现两个东西：

| 能力 | 作用 |
| --- | --- |
| `UsageEvent` | 记录实际 `sandbox_active_ms`、模型 token、模型请求数、R2 写入/读取等原始用量。 |
| `QuotaPolicy` + `UsageReservation` | 在启动前限制每个 User 的并发 Lease、最长运行、模型请求和每日预算。 |

流程：先检查用户级 `QuotaPolicy`，在 D1 写 `UsageReservation` 和 Run，再创建/复用沙箱。任何计量异常都默认阻止新的平台 Gemini Run，不能“先运行、以后补记”。

BYOK 仍受沙箱时间、存储、并发和滥用限制；它只改变模型 Key 的来源。

## 7. 非目标

- `tenants`、`memberships`、`organizations` 表。
- `plans`、`subscriptions`、`prices`、`invoices`、`payments` 表或 API。
- 将真实 Provider Key、E2B sandbox ID、Container ID 返回给前端。

## 8. 外部依据

- [Better Auth 安装与环境变量](https://better-auth.com/docs/installation) 和 [D1 支持](https://better-auth.com/blog/1-5)
- [Pi 模型与自定义 Provider](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)
- [Gemini API Key 指南](https://ai.google.dev/gemini-api/docs/api-key)
- [Cloudflare D1 Binding](https://developers.cloudflare.com/d1/worker-api/d1-database/) 与 [R2 Binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/)
