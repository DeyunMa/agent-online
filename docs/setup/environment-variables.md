# 环境变量与 Worker Binding

> 状态：Better Auth、Gemini 3.6 Flash ModelGateway、E2B、Workflow、Pi/Goose 组合模板、受控 Terminal、Project Preview、Changes 和脱敏 Sentry Error Monitoring 均已完成私有 Cloudflare 配置；私有 Preview 的仓库部署目标使用 `public` 模式向 allowlist 用户公开 Pi/Goose 选择。
> 关联：[示例文件](../../.dev.vars.example) · [外部依赖与待补充项](./external-dependencies.md) · [数据、认证与模型](../architecture/03-data-auth-and-models.md)

## 1. 先区分三类配置

| 类别 | 放置位置 | 示例 |
| --- | --- | --- |
| Worker Secret | 本地 `.dev.vars`；远程环境使用 `wrangler secret put --env <name>`。 | Better Auth Secret、Gemini Key、E2B Key、私有部署邮箱、服务端 Sentry DSN。 |
| Worker 非敏感变量 | `wrangler.jsonc` 的 `vars`。 | Sandbox Provider、空闲 TTL、默认模型 ID、访问模式、Run 开关和 Sentry environment。 |
| 浏览器/构建变量 | 忽略的 `.env.<mode>.local` 或构建进程环境。 | 浏览器 Sentry DSN/environment、源码映射上传组织/项目/token。 |
| Cloudflare Binding | `wrangler.jsonc`。 | `DB`、`ASSETS`、`AGENT_RUN_WORKFLOW`。 |

不要把真实 Key 放进 `wrangler.jsonc`、Git、截图或聊天消息。`.dev.vars.example` 只保留变量名和示例值。

## 2. 本地 fake 模式的最小值

只做 UI、认证、Project 和 fake Run 开发时，只需要：

| 变量 | 是否需要你提供 | 用途 |
| --- | --- | --- |
| `BETTER_AUTH_URL` | 是。 | Better Auth Cookie、跳转和安全 origin 的基准 URL。 |
| `BETTER_AUTH_SECRET` | 是，但由项目自行生成。 | Better Auth 的签名与加密 Secret。 |

邮箱密码第一版不发邮件，因此不需要 Google OAuth、SMTP、Resend、邮件验证或密码找回相关环境变量。`BETTER_AUTH_URL` 不是 OAuth 专用变量；例如本地可设为 `http://localhost:5173`。

## 3. 真实 E2B 模式需要的值

| 变量 | 何时需要 | 用途 |
| --- | --- | --- |
| `GEMINI_API_KEY` | 真实 Pi/Goose Run 或显式 E2E 时。 | 只由 Worker ModelGateway 调用平台 Gemini；不进入沙箱。 |
| `E2B_API_KEY` | `RUNTIME_PROVIDER=e2b` 或显式运行 [E2B + Pi/Goose + Gemini E2E](../testing/e2b-agent-runtimes-gemini.md) 时。 | 只供服务端创建和管理沙箱。 |
| `E2B_TEMPLATE_ID` | `RUNTIME_PROVIDER=e2b` 或运行真实 spike 时。 | 非敏感的精确 E2B build reference；只由服务端创建沙箱时读取。 |

`BETTER_AUTH_SECRET` 用 `openssl rand -base64 32` 独立生成，至少保持 32 个高熵字符。不要复用 Gemini 或 E2B Key。

BYOK 尚未设计，因此不需要 `CREDENTIAL_ENCRYPTION_KEY`、模型租约 Secret 或任何用户模型 Key 配置。

## 4. 非敏感运行配置

| 变量 | 推荐开发值 | 说明 |
| --- | --- | --- |
| `RUNTIME_PROVIDER` | 本地 UI 开发用 `fake`；真实链路用 `e2b` | 选择已安装的 `SandboxRuntime` Adapter；默认 `fake`。 |
| `DEFAULT_MODEL_ID` | `gemini-3.6-flash` | ModelGateway 的服务端默认模型。 |
| `RUNTIME_IDLE_TTL_SECONDS` | `600` | Project 空闲多久后由 Workflow 停止当前沙箱。 |
| `MAX_RUN_WALL_SECONDS` | `1800` | 单个 AgentRun 最大墙钟时间；最大 3600 秒。 |
| `E2B_TEMPLATE_ID` | 精确 `agent-online-pi-goose-runtime:<build-id>` | Pi + Goose 组合模板的不可变 build reference。当前 v4 还固定 npm/pnpm、Python/pip、Git/Bash、rg/jq、归档/进程诊断/原生编译工具，以及只读 `/opt/agent-online/preview` 下的平台 Vite；能力清单写入只读 manifest。构建方式见 [真实链路 E2E](../testing/e2b-agent-runtimes-gemini.md)。 |
| `MODEL_GATEWAY_BASE_URL` | 通常不设置 | 本地 E2B 无法访问 `localhost` 时，覆盖为公开 HTTPS tunnel；代码只保留固定网关路径。 |
| `GOOSE_RUNTIME_MODE` | 普通开发不设置或 `disabled`；私有 Preview 为 `public` | `disabled` 只允许 Pi；`spike` 允许显式 API/E2E 调用 Goose但不向 UI 公布；`public` 通过安全 capabilities 公布选项，创建 Run 仍要求认证和 Project 所有权。只有 E2B 支持 Goose。 |
| `SENTRY_ENVIRONMENT` | 本地通常不设置；Preview 为 `preview` | 服务端错误事件的固定环境标签；没有 DSN 时不会初始化 SDK。 |

当前默认 AgentRuntime 固定为 `pi`，不是环境变量。`GOOSE_RUNTIME_MODE` 只控制第二 adapter 的执行与公开门槛，不改变 Project 默认值。
`spike` 和 `public` 都不构成用户权限边界；认证与邮箱 allowlist 仍负责访问控制。
`public` 只决定 `/api/capabilities` 和 UI 是否公布 Goose，不能绕过 Project 所有权。

## 5. Sentry 错误监控与源码映射

Sentry 不属于产品功能前提。完全不配置这些变量时，应用、测试和普通
`pnpm build` 仍可运行；只有错误上报和源码还原不可用。

| 变量 | 位置 | 用途 |
| --- | --- | --- |
| `SENTRY_DSN` | 本地 `.dev.vars` 或远程 Worker Secret | Hono、Workflow 与服务端 `DiagnosticReporter` 的错误上报。 |
| `SENTRY_ENVIRONMENT` | `wrangler.jsonc` 非敏感变量 | 服务端环境标签。 |
| `VITE_SENTRY_DSN` | 忽略的 `.env.preview.local` | 编译进 React bundle 的公开 DSN 配置。 |
| `VITE_SENTRY_ENVIRONMENT` | 忽略的 `.env.preview.local` | 浏览器环境标签。 |
| `SENTRY_AUTH_TOKEN` | 忽略的 `.env.sentry-build-plugin` 或部署进程环境 | 仅用于构建期上传源码映射；当前 token 只需要 `org:ci`。 |
| `SENTRY_ORG` | 同上 | 源码映射目标组织。 |
| `SENTRY_PROJECT` | 同上 | 源码映射目标项目。 |
| `SENTRY_UPLOAD_SOURCEMAPS` | 部署脚本内部 | 显式打开源码映射上传；普通 build/dry-run 不设置。 |

`VITE_SENTRY_DSN` 会进入浏览器 bundle，因此不能承担认证作用。`SENTRY_AUTH_TOKEN`
才是敏感上传凭据，不能写入 `.env.example` 的有效值、Worker Secret、Cloudflare
Dashboard 变量或 Git。当前两端都关闭 Logs、Tracing、Metrics、Replay 和 breadcrumbs；
变量存在不代表允许扩大采集范围。

## 6. 部署访问与执行开关

| 变量 | 本地默认 | Preview 值 | 说明 |
| --- | --- | --- | --- |
| `ACCESS_MODE` | 未设置即 `open` | `allowlist` | 控制哪些邮箱能注册、登录和继续访问产品 API。 |
| `ACCESS_ALLOWED_EMAILS` | 不需要 | 必填 Secret | 逗号分隔的邮箱；会 trim 并转小写比较。allowlist 模式缺失或为空时服务端拒绝启动受保护路径。 |
| `RUNS_ENABLED` | 未设置即 `true` | 当前 `true` | 新建 AgentRun 的服务端总开关。Preview 首次锁定部署使用 `false`；关闭时不创建 Message、Lease 或 AgentRun。 |

`ACCESS_ALLOWED_EMAILS` 控制整个私有部署的访问。当前没有 `ADMIN_EMAILS`、维护者角色或管理 API，不能把登录 allowlist 解释成管理员权限。

浏览器通过 `/api/capabilities` 读取 `runCreationEnabled`、`terminalEnabled`、`previewEnabled`、`changesEnabled`、默认 Runtime 和可公开 Runtime ID，不会得到 `spike` Runtime、白名单、Secret 或其他部署配置。这些 capability 只表示服务端安装了对应 E2B 能力，不包含 Provider 标识、端口、traffic token、Git command 或内部路径。前端禁用只是交互反馈，服务端所有权、固定参数与互斥才是强制边界。

## 7. Cloudflare Binding，不是环境变量

这些由 `wrangler.jsonc` 绑定，在 Worker 中通过 `env` 访问；用户不应把它们填进 `.dev.vars`：

| Binding | 类型 | 用途 |
| --- | --- | --- |
| `DB` | D1 | Better Auth 与应用数据表。 |
| `ASSETS` | Workers Assets | React 构建产物。 |
| `AGENT_RUN_WORKFLOW` | Cloudflare Workflows | 每个真实 AgentRun 的执行、重试、deadline 和空闲清理，以及 Terminal/Preview expiry 与关闭后的 idle cleanup。 |

V1 不配置 `PROJECT_BUCKET`、R2 或 Durable Object Binding。`AGENT_RUN_WORKFLOW` 已在 `wrangler.jsonc` 声明；它不需要用户在 `.dev.vars` 填值。D1 ID 仍是本地开发占位值，远程部署前必须替换。

`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN` 只在 Wrangler 自动化/CI 部署时需要，不是 Worker 运行时 Secret；本机交互式 `wrangler login` 时不必提供给应用。

## 8. `.dev.vars` 与远程 Secret

本地：复制示例文件为 `.dev.vars` 后填写当前必需值。该文件已在 `.gitignore` 中。

Preview：每个敏感变量用 Wrangler 单独写入，例如：

```sh
pnpm wrangler secret put GEMINI_API_KEY --env preview
pnpm wrangler secret put BETTER_AUTH_SECRET --env preview
pnpm wrangler secret put E2B_API_KEY --env preview
pnpm wrangler secret put ACCESS_ALLOWED_EMAILS --env preview
pnpm wrangler secret put SENTRY_DSN --env preview
```

启用真实 E2B 才写入 Gemini/E2B Secret。`SENTRY_DSN` 只启用服务端错误监控；
`ADMIN_EMAILS` 仍不存在。不同环境的 Binding、`vars` 和构建期 `VITE_*` 不会自动继承，
部署 staging/production 前必须逐项配置和检查。

完整顺序见 [Cloudflare 私有 Preview 部署](./preview-deployment.md)。

## 9. 当前不需要的变量

- R2 Bucket、R2 S3 Access Key 或 Project 文件备份配置。
- Stripe / 支付平台 Key，订阅、账单、发票或价格配置。
- Google OAuth Client ID / Secret 或其他第三方登录变量。
- SMTP、Resend、邮件验证和密码找回变量。
- `CREDENTIAL_ENCRYPTION_KEY`，直到明确开始实现 BYOK 写入。
- Goose 不需要独立模型 Key，它只能使用现有短时 ModelGateway capability。Claude Code 或 Codex CLI 的凭据仍不需要。
- Preview 固定端口、preset、启动等待和 30 分钟上限是代码合同，不提供环境变量或浏览器覆盖；改动这些边界需要先更新 ADR-0006。
- Changes 的固定 Git/Bash/coreutils 路径、输出上限和危险配置拒绝是代码合同，不提供环境变量或浏览器覆盖；改动前先更新 ADR-0007。

## 10. 外部依据

- [Better Auth 环境变量](https://better-auth.com/docs/installation)
- [Better Auth 邮箱密码登录](https://better-auth.com/docs/authentication/email-password)
- [Gemini API Key 指南](https://ai.google.dev/gemini-api/docs/api-key)
- [E2B Quickstart 与 `E2B_API_KEY`](https://e2b.dev/docs/quickstart)
- [Cloudflare Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/) 与 [Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/)
- [Cloudflare Workflows Workers API](https://developers.cloudflare.com/workflows/build/workers-api/)
- [Sentry Cloudflare SDK](https://github.com/getsentry/sentry-javascript/blob/develop/packages/cloudflare/README.md)
- [Sentry JavaScript Source Maps](https://docs.sentry.io/platforms/javascript/guides/cloudflare/sourcemaps/)
