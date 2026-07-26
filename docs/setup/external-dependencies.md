# 外部依赖与待补充项

> 状态：Preview 代码、环境骨架和本地 dry-run 已就绪；远程资源尚未创建。本文只记录变量名和状态，不记录任何真实凭据值。
> 关联：[环境变量](./environment-variables.md) · [本地开发](./local-development.md) · [交付阶段](../architecture/04-delivery-and-cost.md)

## 1. 当前本地开发

| 依赖 | 配置入口 | 当前用途 | 状态 |
| --- | --- | --- | --- |
| Better Auth Secret | `BETTER_AUTH_SECRET` | 本地邮箱密码认证。 | 已由本地 `.dev.vars` 提供。 |
| Better Auth URL | `BETTER_AUTH_URL` | Cookie 与受信任 origin；本地应匹配实际访问地址。 | 已由本地 `.dev.vars` 提供。 |
| Gemini API | `GEMINI_API_KEY` | D2 Worker ModelGateway 和真实 E2E。 | 已由本地 `.dev.vars` 提供。 |
| E2B | `E2B_API_KEY` | 创建和管理真实开发沙箱。 | 已由本地 `.dev.vars` 提供。 |
| E2B Pi Template | `E2B_TEMPLATE_ID` | 固定 Node、Pi 和 `/workspace` 的项目模板。 | 项目模板已构建；本地引用只保存在 `.dev.vars`。 |
| Local D1 | `DB` Binding | Better Auth 与产品数据。 | Wrangler 本地数据库可直接迁移，无需云端账号资源。 |
| Local Workflows | `AGENT_RUN_WORKFLOW` Binding | 真实 Run 执行所有权、重试和 TTL。 | `wrangler.jsonc` 已声明；不需要单独 Key。 |

本地功能开发不需要 R2、支付平台、OAuth、SMTP、邮件服务或 Sentry。

## 2. Cloudflare 预览部署前需要用户确认

以下操作会创建或修改远程资源，代码不会自行执行。准备部署预览环境时，需要用户明确授权并补充：

| 待办 | 用户需要提供或确认 | 项目侧动作 |
| --- | --- | --- |
| Cloudflare 身份 | 确认当前 Wrangler 登录账号和目标 Account。 | 检查登录状态，不把凭据写入应用。 |
| 远程 D1 | 确认创建 `agent-online-preview-db`。 | 创建数据库、替换 `env.preview` 的占位 `database_id`、应用远程迁移。 |
| Worker 地址 | 确认使用 `workers.dev` 还是自定义域名。 | 设置生产 `BETTER_AUTH_URL` 并检查同源 Cookie。 |
| Preview Secret | 为 Preview 独立准备 `BETTER_AUTH_SECRET`。 | 通过带 `--env preview` 的 `wrangler secret put` 写入，不进入 Git。 |
| 模型与沙箱 Secret | 确认预览环境允许使用现有 Gemini/E2B 账号。 | 写入 `GEMINI_API_KEY`、`E2B_API_KEY` 和非敏感 `E2B_TEMPLATE_ID`。 |
| 私有访问 | 提供一个或多个受邀邮箱。 | 以 `ACCESS_ALLOWED_EMAILS` Preview Secret 写入；保持 `ACCESS_MODE=allowlist`。 |
| Cloudflare Workflow | 确认预览环境启用 Workflows。 | 部署已声明的 `AGENT_RUN_WORKFLOW`，验证 Free 计划 10ms step CPU 与 subrequest 限额；不创建第二个服务。 |

首次远程部署前还必须重新核对 Cloudflare、E2B 和 Gemini 当时的免费额度、计价与限额。第一次部署保持 `RUNS_ENABLED=false`，通过认证和 Project smoke 后才为受邀账号打开真实 Run。执行步骤见 [Cloudflare 私有 Preview 部署](./preview-deployment.md)。

## 3. 功能推进到对应阶段才需要

| 能力 | 可能需要的外部项 | 启用条件 |
| --- | --- | --- |
| 基础错误监控 | Sentry 项目与 `SENTRY_DSN`。 | 完成脱敏 `beforeSend`，不上传 prompt、文件、终端或密钥。 |
| 管理用量视图 | `ADMIN_EMAILS`。 | `/api/admin/usage` 和服务端 allowlist 已实现。 |
| GitHub 仓库导入/同步 | GitHub App ID、Private Key、Webhook Secret。 | 先单独设计仓库权限、安装范围、撤销和沙箱凭据流。 |
| BYOK | 用户 Key 加密与轮换基础设施。 | 先通过独立 ADR 决定加密、访问、撤销和泄漏响应。 |
| 第二个 Sandbox Provider | 对应 Provider 账号和服务端 Key。 | 已有独立 `SandboxRuntime` Adapter、能力声明和 E2E。 |
| 第二个 Agent Runtime | 该 Agent 所需许可与模型凭据路径。 | 已有独立 `AgentRuntime` Adapter、事件映射、取消和安全验收。 |

## 4. 当前明确不需要

- R2 Bucket、S3 Access Key、Project 文件快照或文件恢复服务。
- Stripe、价格、套餐、订阅、充值、发票或支付 Webhook。
- Google OAuth Client ID/Secret 或其他第三方登录配置。
- SMTP、Resend、邮箱验证和密码找回服务。
- Goose、Claude Code 或 Codex CLI 凭据。
- 把 Cloudflare Account ID/API Token 当作 Worker 运行时 Secret。

每次新增外部依赖时，先更新本表的用途、数据边界、是否敏感、谁负责提供和删除方式，再修改代码或远程资源。
