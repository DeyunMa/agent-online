# 环境变量与 Worker Binding

> 状态：Better Auth、Gemini 3.6 Flash ModelGateway、E2B 与 Workflow 配置均已完成 Pi 远程验收；Pi/Goose 组合模板和 adapter E2E 已通过，Goose 产品启用仍待 Preview 验收。
> 关联：[示例文件](../../.dev.vars.example) · [外部依赖与待补充项](./external-dependencies.md) · [数据、认证与模型](../architecture/03-data-auth-and-models.md)

## 1. 先区分三类配置

| 类别 | 放置位置 | 示例 |
| --- | --- | --- |
| Secret | 本地 `.dev.vars`；远程环境使用 `wrangler secret put --env <name>`。 | Better Auth Secret、Gemini Key、E2B Key、私有部署邮箱。 |
| 非敏感变量 | `wrangler.jsonc` 的 `vars`。 | Sandbox Provider、空闲 TTL、默认模型 ID、访问模式和 Run 开关。 |
| Cloudflare Binding | `wrangler.jsonc`。 | `DB`、`ASSETS`、`AGENT_RUN_WORKFLOW`。 |

不要把真实 Key 放进 `wrangler.jsonc`、Git、截图或聊天消息。`.dev.vars.example` 只保留变量名和示例值。

## 2. 当前需要准备的值

所有本地模式都需要：

| 变量 | 是否需要你提供 | 用途 |
| --- | --- | --- |
| `GEMINI_API_KEY` | 是，你已有。 | 平台默认 Gemini；真实 E2B Run 通过 Worker ModelGateway 使用。 |
| `BETTER_AUTH_URL` | 是。 | Better Auth Cookie、跳转和安全 origin 的基准 URL。 |
| `BETTER_AUTH_SECRET` | 是，但由项目自行生成。 | Better Auth 的签名与加密 Secret。 |

邮箱密码第一版不发邮件，因此不需要 Google OAuth、SMTP、Resend、邮件验证或密码找回相关环境变量。`BETTER_AUTH_URL` 不是 OAuth 专用变量；例如本地可设为 `http://localhost:5173`。

## 3. 真实 E2B 模式需要的值

| 变量 | 何时需要 | 用途 |
| --- | --- | --- |
| `E2B_API_KEY` | `RUNTIME_PROVIDER=e2b` 或显式运行 [E2B + Pi/Goose + Gemini E2E](../testing/e2b-agent-runtimes-gemini.md) 时。 | 只供服务端创建和管理沙箱。 |
| `E2B_TEMPLATE_ID` | `RUNTIME_PROVIDER=e2b` 或运行真实 spike 时。 | 非敏感的精确 E2B build reference；只由服务端创建沙箱时读取。 |
| `ADMIN_EMAILS` | 接入内部用量页面时。 | 逗号分隔的维护者邮箱 allowlist，不是部署登录白名单或用户角色系统。 |
| `SENTRY_DSN` | 安装 Sentry SDK 后。 | 可选 Worker 错误监控的项目 DSN；它不是 Gemini/E2B 那类服务端凭据，当前脚手架不读取它。 |

`BETTER_AUTH_SECRET` 用 `openssl rand -base64 32` 独立生成，至少保持 32 个高熵字符。不要复用 Gemini 或 E2B Key。

BYOK 尚未设计，因此不需要 `CREDENTIAL_ENCRYPTION_KEY`、模型租约 Secret 或任何用户模型 Key 配置。

## 4. 非敏感运行配置

| 变量 | 推荐开发值 | 说明 |
| --- | --- | --- |
| `RUNTIME_PROVIDER` | 本地 UI 开发用 `fake`；真实链路用 `e2b` | 选择已安装的 `SandboxRuntime` Adapter；默认 `fake`。 |
| `DEFAULT_MODEL_ID` | `gemini-3.6-flash` | ModelGateway 的服务端默认模型。 |
| `RUNTIME_IDLE_TTL_SECONDS` | `600` | Project 空闲多久后由 Workflow 停止当前沙箱。 |
| `MAX_RUN_WALL_SECONDS` | `1800` | 单个 AgentRun 最大墙钟时间；最大 3600 秒。 |
| `E2B_TEMPLATE_ID` | 精确 `agent-online-pi-goose-runtime:<build-id>` | Pi + Goose 组合模板的不可变 build reference；构建方式见 [真实链路 E2E](../testing/e2b-agent-runtimes-gemini.md)。 |
| `MODEL_GATEWAY_BASE_URL` | 通常不设置 | 本地 E2B 无法访问 `localhost` 时，覆盖为公开 HTTPS tunnel；代码只保留固定网关路径。 |
| `GOOSE_RUNTIME_MODE` | 不设置或 `disabled` | `disabled` 只允许 Pi；`spike` 允许显式 API/E2E 调用 Goose 但不向 UI 公布；`public` 才公开选择。只有 E2B 支持 Goose。 |

当前默认 AgentRuntime 固定为 `pi`，不是环境变量。`GOOSE_RUNTIME_MODE` 只控制第二 adapter 的执行与公开门槛，不改变 Project 默认值。
`spike` 不构成用户权限边界：已通过现有认证和部署访问策略的调用者仍可手工提交
`agentRuntimeId=goose`。它只能在邮箱 allowlist 保护的私有 Preview 中短时启用。

## 5. 部署访问与执行开关

| 变量 | 本地默认 | Preview 值 | 说明 |
| --- | --- | --- | --- |
| `ACCESS_MODE` | 未设置即 `open` | `allowlist` | 控制哪些邮箱能注册、登录和继续访问产品 API。 |
| `ACCESS_ALLOWED_EMAILS` | 不需要 | 必填 Secret | 逗号分隔的邮箱；会 trim 并转小写比较。allowlist 模式缺失或为空时服务端拒绝启动受保护路径。 |
| `RUNS_ENABLED` | 未设置即 `true` | 当前 `true` | 新建 AgentRun 的服务端总开关。Preview 首次锁定部署使用 `false`；关闭时不创建 Message、Lease 或 AgentRun。 |

`ACCESS_ALLOWED_EMAILS` 控制整个私有部署的访问；未来的 `ADMIN_EMAILS` 只控制维护者 API。二者不能合并，否则普通受邀测试用户会意外获得管理权限。

浏览器通过 `/api/capabilities` 读取 `runCreationEnabled`、默认 Runtime 和可公开 Runtime ID，不会得到 `spike` Runtime、白名单、Secret 或其他部署配置。前端禁用只是交互反馈，服务端创建 Run API 才是强制边界。

## 6. Cloudflare Binding，不是环境变量

这些由 `wrangler.jsonc` 绑定，在 Worker 中通过 `env` 访问；用户不应把它们填进 `.dev.vars`：

| Binding | 类型 | 用途 |
| --- | --- | --- |
| `DB` | D1 | Better Auth 与应用数据表。 |
| `ASSETS` | Workers Assets | React 构建产物。 |
| `AGENT_RUN_WORKFLOW` | Cloudflare Workflows | 每个真实 AgentRun 的执行、重试、deadline 和空闲清理。 |

V1 不配置 `PROJECT_BUCKET`、R2 或 Durable Object Binding。`AGENT_RUN_WORKFLOW` 已在 `wrangler.jsonc` 声明；它不需要用户在 `.dev.vars` 填值。D1 ID 仍是本地开发占位值，远程部署前必须替换。

`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN` 只在 Wrangler 自动化/CI 部署时需要，不是 Worker 运行时 Secret；本机交互式 `wrangler login` 时不必提供给应用。

## 7. `.dev.vars` 与远程 Secret

本地：复制示例文件为 `.dev.vars` 后填写当前必需值。该文件已在 `.gitignore` 中。

Preview：每个敏感变量用 Wrangler 单独写入，例如：

```sh
pnpm wrangler secret put GEMINI_API_KEY --env preview
pnpm wrangler secret put BETTER_AUTH_SECRET --env preview
pnpm wrangler secret put E2B_API_KEY --env preview
pnpm wrangler secret put ACCESS_ALLOWED_EMAILS --env preview
```

启用真实 E2B 才写入 E2B Secret。Sentry 集成启用后，`SENTRY_DSN` 可作为部署配置提供。不同环境的 Binding 和 `vars` 不会自动继承，部署 staging/production 前必须逐项配置和检查。

完整顺序见 [Cloudflare 私有 Preview 部署](./preview-deployment.md)。

## 8. 当前不需要的变量

- R2 Bucket、R2 S3 Access Key 或 Project 文件备份配置。
- Stripe / 支付平台 Key，订阅、账单、发票或价格配置。
- Google OAuth Client ID / Secret 或其他第三方登录变量。
- SMTP、Resend、邮件验证和密码找回变量。
- `CREDENTIAL_ENCRYPTION_KEY`，直到明确开始实现 BYOK 写入。
- Goose 不需要独立模型 Key，它只能使用现有短时 ModelGateway capability。Claude Code 或 Codex CLI 的凭据仍不需要。

## 9. 外部依据

- [Better Auth 环境变量](https://better-auth.com/docs/installation)
- [Better Auth 邮箱密码登录](https://better-auth.com/docs/authentication/email-password)
- [Gemini API Key 指南](https://ai.google.dev/gemini-api/docs/api-key)
- [E2B Quickstart 与 `E2B_API_KEY`](https://e2b.dev/docs/quickstart)
- [Cloudflare Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/) 与 [Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/)
- [Cloudflare Workflows Workers API](https://developers.cloudflare.com/workflows/build/workers-api/)
