# 环境变量与 Worker Binding

> 状态：架构与工程基线 v0.3
> 关联：[示例文件](../../.dev.vars.example) · [数据、认证与模型](../architecture/03-data-auth-and-models.md)

## 1. 先区分三类配置

| 类别 | 放置位置 | 示例 |
| --- | --- | --- |
| Secret | 本地 `.dev.vars`；生产 `wrangler secret put`。 | Better Auth Secret、Gemini Key、以后 E2B Key。 |
| 非敏感变量 | 代码默认值；部署后需要覆盖时使用 `wrangler.jsonc` 的 `vars`。 | 沙箱 Provider、空闲 TTL、默认模型 ID。 |
| Cloudflare Binding | `wrangler.jsonc`。 | `DB`、`PROJECT_BUCKET`、`ASSETS`、以后 `PROJECT_RUNTIME`。 |

不要把真实 Key 放进 `wrangler.jsonc`、Git、截图或聊天消息。`.dev.vars.example` 只保留变量名和示例值。

## 2. 当前需要准备的值

第一阶段不接第三方登录，当前只需要下列值：

| 变量 | 是否需要你提供 | 用途 |
| --- | --- | --- |
| `GEMINI_API_KEY` | 是，你已有。 | 平台默认 Gemini；只供 Worker 的 ModelGateway 使用。 |
| `BETTER_AUTH_URL` | 是，确认本地/生产应用 URL。 | Better Auth Cookie、跳转和安全 origin 的基准 URL。 |
| `BETTER_AUTH_SECRET` | 是，但由项目自行生成。 | Better Auth 的签名与加密 Secret。 |

邮箱密码第一版不发邮件，因此不需要 Google OAuth、SMTP、Resend、邮件验证或密码找回相关环境变量。注册和登录直接使用 Better Auth 的 `emailAndPassword.enabled = true`。

`BETTER_AUTH_URL` 仍需显式设置，例如本地 `http://localhost:5173`；它不是第三方 OAuth 专用变量，而是 Better Auth 的应用基准地址。

## 3. 项目自行生成的 Secret

下列值不需要从第三方领取；不要复用 Gemini 或 E2B Key：

| 变量 | 何时需要 | 生成方式 |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | 一开始启用 Better Auth 时。 | `openssl rand -base64 32`；至少 32 个高熵字符。 |
| `CREDENTIAL_ENCRYPTION_KEY` | 仅启用 BYOK 写入前。 | 独立生成 32 字节高熵值；用于版本化 AEAD 加密。 |

模型租约使用 D1 中可撤销的随机 token 哈希，不另设签名 Secret。

## 4. 非敏感运行配置

| 变量 | 推荐开发值 | 说明 |
| --- | --- | --- |
| `RUNTIME_PROVIDER` | `fake`，接 E2B 后改 `e2b` | 决定 `SandboxRuntime` Adapter。 |
| `DEFAULT_MODEL_ID` | 项目代码默认值 | 平台 Gemini 的逻辑模型 ID。 |
| `RUNTIME_IDLE_TTL_SECONDS` | `600` | Project 空闲多久 checkpoint 并停止 Lease。 |
| `MAX_ACTIVE_SANDBOXES_PER_USER` | `1` | 第一版的用户级并发沙箱上限。 |
| `MAX_RUN_WALL_SECONDS` | `1800` | 单个 Agent Run 的最大墙钟时间。 |
| `E2B_TEMPLATE_ID` | 留空 | 自定义默认 Agent 基础镜像建好后才填写。 |

当前 `defaultAgentRuntime` 在代码中固定为 `pi`，而不是对外环境变量。这样可避免部署配置或浏览器请求误选尚未安装的 Runtime；当第二个适配器完成能力与安全验收后，再设计显式的部署级默认值。

## 5. Cloudflare Binding，不是环境变量

这些由 `wrangler.jsonc` 绑定，在 Worker 中通过 `env` 访问；用户不应把它们填进 `.dev.vars`：

| Binding | 类型 | 用途 |
| --- | --- | --- |
| `DB` | D1 | Better Auth 与应用数据表。 |
| `PROJECT_BUCKET` | R2 | Revision、产物和事件归档。 |
| `ASSETS` | Workers Assets | React 构建产物。 |
| `PROJECT_RUNTIME` | Durable Object，后续可选 | Project 级 Lease 启停串行化和终端连接协调。 |

配置里的 `agent-online-db`、`agent-online-projects` 和全零 D1 ID 都只是尚未创建资源的占位值。首次远程部署前，需要在 Cloudflare 创建真实 D1/R2，填入实际 database ID 和 bucket name。

`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN` 只在 Wrangler 自动化/CI 部署时需要，不是 Worker 运行时 Secret；本机交互式 `wrangler login` 时不必提供给应用。

## 6. `.dev.vars` 与生产 Secret

本地：复制示例文件为 `.dev.vars` 后填写真实值。该文件已在 `.gitignore` 中。

生产：每个敏感变量用 Wrangler 单独写入，例如：

```sh
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put E2B_API_KEY
```

不同环境的 Binding 和 `vars` 不会自动继承，部署 staging/production 前必须逐项配置和检查。

## 7. 当前不需要的变量

- Stripe / 支付平台 Key。
- 订阅、账单、发票或价格配置。
- Google OAuth Client ID / Secret 或其他第三方登录变量。
- SMTP、Resend、邮件验证和密码找回变量。
- R2 S3 Access Key；第一版通过 Worker Binding 访问 R2，不让沙箱持有桶级凭证。
- `CREDENTIAL_ENCRYPTION_KEY`，直到明确开始实现 BYOK 写入。
- Goose、Claude Code 或 Codex CLI 的凭据。它们在没有适配器和单独安全设计前不接入应用。

## 8. 外部依据

- [Better Auth 环境变量](https://better-auth.com/docs/installation)
- [Better Auth 邮箱密码登录](https://better-auth.com/docs/authentication/email-password)
- [Pi Provider 与 `GEMINI_API_KEY`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)
- [E2B Quickstart 与 `E2B_API_KEY`](https://e2b.dev/docs/quickstart)
- [Cloudflare Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/) 与 [Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/)
