# 本地开发基线

> 状态：D2/D3 与 Goose 真实链路已完成；2026-07-30 已部署受 allowlist 保护的 Pi/Goose UI 选择，并实现受控单文件上传。
> 关联：[ADR-0002](../adr/0002-run-agent-process-and-lease-lifecycle.md) · [ADR-0004](../adr/0004-goose-agent-runtime-spike.md) · [ADR-0006](../adr/0006-controlled-project-preview.md) · [ADR-0007](../adr/0007-controlled-project-changes.md) · [环境变量](./environment-variables.md)

## 工程形态

Agent Online 只有一个可部署产品：React SPA 静态资源和 Hono API 同域运行在一个 Cloudflare Worker。`AgentRuntime` 是 Worker 控制平面中的代码模块，不是第二个后端项目或独立微服务；真实 Agent 进程由远程沙箱启动。

源码按职责拆分，而不是拆成两个独立仓库或两个独立部署：

```text
src/client/     React、TanStack Router/Query、界面
src/server/     Hono、Better Auth、HTTP 边界、配置与服务装配
  persistence/  按 Project/Lease/Run/Terminal/Preview/Usage 拆分的 D1 adapter
src/observability/ Provider 无关的诊断合同
src/domain/     Project、SandboxLease、AgentRun 的纯业务规则
src/application/ Project 与 AgentRun 用例、ports、RunCoordinator
src/runtime/    SandboxRuntime 合同与 fake/E2B/Container Adapter
src/agent/      AgentRuntime 合同、Pi/Goose 独立适配器和 registry
src/shared/     客户端与服务端共享 DTO
migrations/     D1 认证表与应用表迁移
worker/         Cloudflare Worker 入口
```

不同 Agent 可以按以上目录边界协作。`src/client` 不得导入 `src/server`，`src/domain` 不得依赖 Cloudflare、Hono、React 或 E2B SDK；`src/agent` 只依赖通用 `SandboxRuntime` 合同，不直接依赖具体供应商 SDK。

## 当前运行时状态

- D1 migration、Better Auth 邮箱密码客户端、Project API、Message 查询、单活跃 Run、SSE 和取消状态转换已经实现；SSE 在自己的请求内轮询 D1 的 Run 状态，页面刷新后可通过当前活跃 Run 查询恢复。
- `FakeSandboxRuntime` 用于无外部成本的 UI/控制面开发；`E2BSandboxRuntime` 支持真实 Linux、进程重连、精确进程终止、PTY、固定 Preview fetch、受控 Git Changes 和沙箱停止。
- Pi 是默认且已验收的 AgentRuntime，它把 `pi --mode rpc` JSONL 映射为统一 Agent 事件。Goose adapter 和组合 E2B 模板已通过本地及私有 Preview 真实 E2E，并由受 allowlist 保护的 capability 在 UI 公布；fake runtime 不执行真实 Agent 二进制。
- `AgentRunWorkflow`、ModelGateway、Run capability、真实 usage、deadline 和空闲 TTL 已实现。远程 Preview 已通过代表性的文件工具调用、取消、deadline 与 10 分钟空闲回收；更复杂任务下的 Workflows Free CPU/subrequest 限额仍需观察。
- 部署级邮箱 allowlist 与 `RUNS_ENABLED` 总开关已实现。本地不设置时默认开放访问并允许 Run，避免增加日常 fake 开发配置。
- Files 读取与单文件根目录上传已实现；fake Runtime 的内存文件不跨请求，因此本地
  fake 控制面会显示明确的沙箱不可用状态并关闭上传。真实上传需要现有空闲 E2B
  Lease；停止 Lease 不发 Files 请求，也不显示缓存的旧目录或文本。
- `GET /api/usage` 和响应式 Usage 页面已实现，合并现有 `agent_runs` 与 Project 删除时
  写入的 `archived_run_usage`；它不需要环境变量或外部服务。本地 fake Run 会产生
  Run 数和沙箱生命周期事实，但不会伪造 token 或模型请求。
- Terminal 已实现并通过远端真实 E2B 验收：同源 WebSocket、临时 D1 硬互斥、30 分钟会话上限、显式关闭、断线清理和 idle Workflow；fake Runtime 明确不提供 Terminal。
- Project Preview 已实现并通过远端真实 E2B 验收：现有 Lease、固定 `/workspace`、平台只读 Vite/端口、入口与依赖预检、同源签名 GET/HEAD 网关、30 分钟 expiry、显式停止、Agent 修改后手动刷新，以及 Run/Terminal 并行。fake Runtime 明确不提供 Preview。
- 只读 Changes 已实现并通过远端真实 E2B 验收：固定 `/workspace/.git`、系统 Git/Bash/coreutils、危险本地配置拒绝、500 项/128 KiB status、每段 128 KiB diff、staged/unstaged 分离和 no-store。fake Runtime 明确不提供 Changes；它不新增 D1、环境变量或外部服务。
- Goose 是当前唯一公开的第二 Runtime；Claude Code、Codex CLI 仍仅在 Runtime ID 合同中预留。
- 当前源码、迁移和 Worker binding 不包含 R2/Revision 路径；本地数据仍可按 ADR-0002 直接重建。

## 运行步骤

1. 安装依赖：`pnpm install`。
2. 在根目录创建本地 `.dev.vars`。fake 模式只填写 `BETTER_AUTH_SECRET` 和 `BETTER_AUTH_URL`；真实 E2B Run 再填写 `GEMINI_API_KEY`、`E2B_API_KEY` 和模板配置。
3. 应用本地 D1 迁移：`pnpm wrangler d1 migrations apply DB --local`。
4. 启动：`pnpm dev`，Vite/Workers 本地地址为 `http://localhost:5173`。
5. 默认 `RUNTIME_PROVIDER` 为空时使用 fake；真实链路设置 `RUNTIME_PROVIDER=e2b`、`E2B_API_KEY`、`E2B_TEMPLATE_ID`，并为本地 E2B 提供可访问的 `MODEL_GATEWAY_BASE_URL`。
6. 首次运行浏览器门禁前安装 Chromium：`pnpm exec playwright install chromium`。
7. 验证：`pnpm check`。该命令依次执行 import boundary、源码凭据扫描、Biome lint/format、严格 typecheck、Node 测试、真实 Workers/D1 迁移测试、production build/产物凭据与 `_headers` 校验，以及独立本地 D1 上的浏览器核心 smoke；GitHub Actions 使用同一门禁。真实 Preview 使用模板内固定的 `/opt/agent-online/preview/node_modules/.bin/vite`，Project 至少需要根目录 `index.html`；若 `package.json` 声明依赖，还必须先在 `/workspace` 安装依赖。平台不会通过 `npx` 下载、读取 Project Vite 配置或执行 Project 自定义 script。

`pnpm build` 会先清理旧 `dist`，并在构建后拒绝任何 `.dev.vars*`、`.env*` 或可识别的凭据内容，同时要求 `public/_headers` 被复制到产物并包含 CSP、referrer、MIME 与 frame 防护。`validate:source-secrets` 同时扫描 Git tracked 和未忽略的工作树文件，但不打印匹配值。Cloudflare Vite 插件在 build 模式下不会序列化本地 Secret；部署产物只使用已通过 Wrangler 配置的远程 Secret。

Playwright 使用 `tests/browser/wrangler.jsonc` 和 `.wrangler/browser-smoke`，启动前会重建这份独立本地 D1，并在进程内随机生成测试 Better Auth Secret。它不读取产品 D1、不调用 E2B/Gemini，也不修改远程资源。

真实部署另使用 `playwright.preview.config.ts` 和
[Hosted Preview E2E](../testing/hosted-preview-e2e.md)。该流程必须显式提供受邀账号，
只在发布后人工触发，不属于默认检查，也不会读取 `.dev.vars`。

`wrangler.jsonc` 顶层的 D1 ID 是本地开发占位值，通用 `pnpm deploy` 会被 production
guard 拒绝。`preview` 环境固定目标 Account 并使用独立的真实 D1 ID；本机
`CLOUDFLARE_ACCOUNT_ID` 若与配置冲突，Preview deploy/preflight 也会拒绝。新增远程
环境时只创建目标 D1 并配置对应环境；R2 不属于 V1。本项目不会自动创建任何云端资源。

需要在本地模拟私有 Preview 时，设置 `ACCESS_MODE=allowlist`、`ACCESS_ALLOWED_EMAILS=<测试邮箱>` 和 `RUNS_ENABLED=false`。远程流程见 [Cloudflare 私有 Preview 部署](./preview-deployment.md)。
