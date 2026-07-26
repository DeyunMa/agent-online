# 外部依赖与待补充项

> 状态：Preview Worker、D1、Workflow、Secret、远程迁移，以及 Pi/Goose、Files、Usage、Terminal、Project Preview、只读 Changes、取消、deadline、空闲 TTL 和手动停止已配置并验证。Goose 仍保持私有 `spike`。
> 关联：[环境变量](./environment-variables.md) · [本地开发](./local-development.md) · [交付阶段](../architecture/04-delivery-and-cost.md)

## 1. 当前本地开发

| 依赖 | 配置入口 | 当前用途 | 状态 |
| --- | --- | --- | --- |
| Better Auth Secret | `BETTER_AUTH_SECRET` | 本地邮箱密码认证。 | 已由本地 `.dev.vars` 提供。 |
| Better Auth URL | `BETTER_AUTH_URL` | Cookie 与受信任 origin；本地应匹配实际访问地址。 | 已由本地 `.dev.vars` 提供。 |
| Gemini API | `GEMINI_API_KEY` | D2 Worker ModelGateway 和真实 E2E。 | 已由本地 `.dev.vars` 提供。 |
| E2B | `E2B_API_KEY` | 创建和管理真实开发沙箱。 | 已由本地 `.dev.vars` 提供。 |
| E2B Pi + Goose Template | `E2B_TEMPLATE_ID` | 固定 Node、Pi、Goose、Git、Bash、coreutils 和 `/workspace` 的组合模板。 | 精确 build 已构建，并完成 adapter、Preview 和 Changes 产品链路 E2E。 |
| Local D1 | `DB` Binding | Better Auth 与产品数据。 | Wrangler 本地数据库可直接迁移，无需云端账号资源。 |
| Local Workflows | `AGENT_RUN_WORKFLOW` Binding | 真实 Run 执行所有权、重试和 TTL。 | `wrangler.jsonc` 已声明；不需要单独 Key。 |

本地功能开发不需要 R2、支付平台、OAuth、SMTP、邮件服务或 Sentry。

## 2. 当前 Cloudflare Preview

以下远程资源已经过用户授权创建或修改。新增、删除或破坏性变更仍需要单独确认：

| 待办 | 用户需要提供或确认 | 项目侧动作 |
| --- | --- | --- |
| Cloudflare 身份 | 目标 Account 已确认，Wrangler OAuth 已连接。 | 已完成；本机其他 Account 环境变量需按资源台账显式排除。 |
| 远程 D1 | `agent-online-preview-db`。 | 已创建并应用 5 个迁移。 |
| Worker 地址 | `workers.dev`。 | 已设置同源 `BETTER_AUTH_URL`，未配置自定义域。 |
| Preview Secret | 独立 `BETTER_AUTH_SECRET`。 | 已以加密 Secret 写入，不进入 Git。 |
| 模型与沙箱 Secret | 现有 Gemini/E2B 账号。 | `GEMINI_API_KEY`、`E2B_API_KEY` 已加密写入；精确 Template ID 由仓库配置。 |
| 私有访问 | owner 邮箱。 | 已以 `ACCESS_ALLOWED_EMAILS` Secret 写入；`ACCESS_MODE=allowlist`。 |
| Cloudflare Workflow | `agent-online-preview-run`。 | 已创建；真实 Pi/Goose、取消、deadline、Run/Terminal/Preview expiry 与空闲回收已成功，复杂任务限额仍需观察。 |

当前部署为 `RUNS_ENABLED=true`，但仍受邮箱 allowlist 保护。owner 已完成注册、Project smoke、真实 Run、Files、Terminal、固定 Vite Preview 和只读 Changes；出现异常成本或 Provider 故障时，将该开关改回 `false` 并重新部署。`RUNS_ENABLED` 只关闭新 AgentRun，不会自动终止已有 Terminal/Preview；需要分别显式停止。实际资源与 Dashboard 入口见 [Cloudflare Preview 资源台账](./cloudflare-preview-resources.md)。

## 3. 当前成本口径

截至 2026-07-26：

| 依赖 | 免费层结论 | 当前风险 |
| --- | --- | --- |
| Worker 与 Static Assets | 当前 Preview 可运行在 Workers Free；静态资源请求和存储无额外费用。 | 动态请求受每天 100,000 次、单次 CPU 和 subrequest 限制。 |
| D1 | Free 包含每天 500 万行读取、10 万行写入和总计 5GB。 | 超出免费日限额后查询失败，不会自动获得无限容量。 |
| Workflows | Workers Free 可用，包含每天 3,000 steps 和 1GB 状态。 | 与 Worker 共享请求/CPU 边界，复杂任务仍需观察。 |
| Workers Logs | Free 包含每天 200,000 条日志事件，保留 3 天。 | 当前 100% head sampling 只适合私有 Preview。 |
| Better Auth | 当前使用自托管开源框架。 | 未使用 Better Auth 托管基础设施。 |
| Gemini API | Gemini 3.6 Flash 当前有 Free Tier；本项目按 owner 的模型额度不计成本。 | 实际是否计费取决于 Key 所属 Google 项目的 tier。 |
| E2B | Hobby 无基础月费，但计算按秒计费，仅提供一次性 $100 credits。 | credits 耗尽后不再是免费算力；空闲 TTL 是主要成本护栏。 |

因此，当前个人开发期通常可以保持账单为 $0，但不能描述为“所有外部依赖永久免费”。当前没有使用 Cloudflare Sandbox/Containers；若未来切换，Sandbox SDK 需要 Workers Paid。

官方口径见 [D2 阶段基线](../status/2026-07-26-d2-baseline.md#4-外部依赖与成本)。

## 4. 功能推进到对应阶段才需要

| 能力 | 可能需要的外部项 | 启用条件 |
| --- | --- | --- |
| 基础错误监控 | Sentry 项目与 `SENTRY_DSN`。 | 完成脱敏 `beforeSend`，不上传 prompt、文件、终端或密钥。 |
| 管理用量视图 | `ADMIN_EMAILS`。 | `/api/admin/usage` 和服务端 allowlist 已实现。 |
| GitHub 仓库导入/同步 | GitHub App ID、Private Key、Webhook Secret。 | 先单独设计仓库权限、安装范围、撤销和沙箱凭据流。 |
| BYOK | 用户 Key 加密与轮换基础设施。 | 先通过独立 ADR 决定加密、访问、撤销和泄漏响应。 |
| 第二个 Sandbox Provider | 对应 Provider 账号和服务端 Key。 | 已有独立 `SandboxRuntime` Adapter、能力声明和 E2E。 |
| 第二个 Agent Runtime | 该 Agent 所需许可与模型凭据路径。 | Goose adapter、组合模板、事件、ModelGateway、D1/Workflow/TTL 已通过；输出脱敏和浏览器公开验收仍待完成。 |

## 5. 当前明确不需要

- R2 Bucket、S3 Access Key、Project 文件快照或文件恢复服务。
- Stripe、价格、套餐、订阅、充值、发票或支付 Webhook。
- Google OAuth Client ID/Secret 或其他第三方登录配置。
- SMTP、Resend、邮箱验证和密码找回服务。
- Goose 独立模型凭据；它复用短时 ModelGateway capability。Claude Code 或 Codex CLI 凭据也不需要。
- 把 Cloudflare Account ID/API Token 当作 Worker 运行时 Secret。

每次新增外部依赖时，先更新本表的用途、数据边界、是否敏感、谁负责提供和删除方式，再修改代码或远程资源。
