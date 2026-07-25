# 环境变量与 Worker Binding

> 状态：目标架构基线 v0.4
> 关联：[示例文件](../../.dev.vars.example) · [数据、认证与模型](../architecture/03-data-auth-and-models.md)

## 1. 先区分三类配置

| 类别 | 放置位置 | 示例 |
| --- | --- | --- |
| Secret | 本地 `.dev.vars`；生产 `wrangler secret put`。 | Better Auth Secret、Gemini Key、E2B Key。 |
| 非敏感变量 | 代码默认值；部署后需要覆盖时使用 `wrangler.jsonc` 的 `vars`。 | Sandbox Provider、空闲 TTL、默认模型 ID、以后 Sentry DSN。 |
| Cloudflare Binding | `wrangler.jsonc`。 | `DB`、`ASSETS`。 |

不要把真实 Key 放进 `wrangler.jsonc`、Git、截图或聊天消息。`.dev.vars.example` 只保留变量名和示例值。

## 2. 当前需要准备的值

第一阶段只需要下列值：

| 变量 | 是否需要你提供 | 用途 |
| --- | --- | --- |
| `GEMINI_API_KEY` | 是，你已有。 | 平台默认 Gemini；只供 Worker 的 ModelGateway 使用。 |
| `BETTER_AUTH_URL` | 是。 | Better Auth Cookie、跳转和安全 origin 的基准 URL。 |
| `BETTER_AUTH_SECRET` | 是，但由项目自行生成。 | Better Auth 的签名与加密 Secret。 |

邮箱密码第一版不发邮件，因此不需要 Google OAuth、SMTP、Resend、邮件验证或密码找回相关环境变量。`BETTER_AUTH_URL` 不是 OAuth 专用变量；例如本地可设为 `http://localhost:5173`。

## 3. 按阶段才需要的值

| 变量 | 何时需要 | 用途 |
| --- | --- | --- |
| `E2B_API_KEY` | 接入真实 E2B SandboxRuntime 时。 | 只供服务端创建和管理沙箱。 |
| `ADMIN_EMAILS` | 接入内部用量页面时。 | 逗号分隔的维护者邮箱 allowlist，不是用户角色系统。 |
| `SENTRY_DSN` | 安装 Sentry SDK 后。 | 可选 Worker 错误监控的项目 DSN；它不是 Gemini/E2B 那类服务端凭据，当前脚手架不读取它。 |

`BETTER_AUTH_SECRET` 用 `openssl rand -base64 32` 独立生成，至少保持 32 个高熵字符。不要复用 Gemini 或 E2B Key。

BYOK 尚未设计，因此不需要 `CREDENTIAL_ENCRYPTION_KEY`、模型租约 Secret 或任何用户模型 Key 配置。

## 4. 非敏感运行配置

| 变量 | 推荐开发值 | 说明 |
| --- | --- | --- |
| `RUNTIME_PROVIDER` | `fake`，接 E2B 后改 `e2b` | 决定 `SandboxRuntime` Adapter。 |
| `DEFAULT_MODEL_ID` | 项目代码默认值 | 平台 Gemini 的逻辑模型 ID。 |
| `RUNTIME_IDLE_TTL_SECONDS` | `600` | Project 空闲多久停止当前沙箱。 |
| `MAX_ACTIVE_SANDBOXES_PER_USER` | `1` | 第一版的用户级并发沙箱上限。 |
| `MAX_RUN_WALL_SECONDS` | `1800` | 单个 AgentRun 的最大墙钟时间。 |
| `E2B_TEMPLATE_ID` | 留空 | 自定义 Pi 基础镜像建好后才填写。 |

当前默认 AgentRuntime 固定为 `pi`，而不是对外环境变量。第二个适配器完成能力和安全验收后，再设计部署级默认值。

## 5. Cloudflare Binding，不是环境变量

这些由 `wrangler.jsonc` 绑定，在 Worker 中通过 `env` 访问；用户不应把它们填进 `.dev.vars`：

| Binding | 类型 | 用途 |
| --- | --- | --- |
| `DB` | D1 | Better Auth 与应用数据表。 |
| `ASSETS` | Workers Assets | React 构建产物。 |

V1 不配置 `PROJECT_BUCKET` 或任何 R2 Binding，也不需要 Durable Object。当前 `wrangler.jsonc` 中的 R2 占位配置是旧脚手架，实施 ADR-0002 时必须删除；当前全零 D1 ID 也仍只是本地开发占位值。

`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN` 只在 Wrangler 自动化/CI 部署时需要，不是 Worker 运行时 Secret；本机交互式 `wrangler login` 时不必提供给应用。

## 6. `.dev.vars` 与生产 Secret

本地：复制示例文件为 `.dev.vars` 后填写当前必需值。该文件已在 `.gitignore` 中。

生产：每个敏感变量用 Wrangler 单独写入，例如：

```sh
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put E2B_API_KEY
```

只有在真实对应功能已实现时才写入 E2B 等额外 Secret。Sentry 集成启用后，`SENTRY_DSN` 可作为部署配置提供。不同环境的 Binding 和 `vars` 不会自动继承，部署 staging/production 前必须逐项配置和检查。

## 7. 当前不需要的变量

- R2 Bucket、R2 S3 Access Key 或工作区备份配置。
- Stripe / 支付平台 Key，订阅、账单、发票或价格配置。
- Google OAuth Client ID / Secret 或其他第三方登录变量。
- SMTP、Resend、邮件验证和密码找回变量。
- `CREDENTIAL_ENCRYPTION_KEY`，直到明确开始实现 BYOK 写入。
- Goose、Claude Code 或 Codex CLI 的凭据。它们没有适配器和单独安全设计前不接入应用。

## 8. 外部依据

- [Better Auth 环境变量](https://better-auth.com/docs/installation)
- [Better Auth 邮箱密码登录](https://better-auth.com/docs/authentication/email-password)
- [Gemini API Key 指南](https://ai.google.dev/gemini-api/docs/api-key)
- [E2B Quickstart 与 `E2B_API_KEY`](https://e2b.dev/docs/quickstart)
- [Cloudflare Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/) 与 [Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/)
