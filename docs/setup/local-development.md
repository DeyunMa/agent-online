# 本地开发基线

> 状态：D2 本地代码与真实 E2B spike 已落地；远程 Cloudflare Workflow 待验收
> 关联：[ADR-0002](../adr/0002-run-agent-process-and-lease-lifecycle.md) · [环境变量](./environment-variables.md)

## 工程形态

Agent Online 只有一个可部署产品：React SPA 静态资源和 Hono API 同域运行在一个 Cloudflare Worker。`AgentRuntime` 是 Worker 控制平面中的代码模块，不是第二个后端项目或独立微服务；真实 Agent 进程由远程沙箱启动。

源码按职责拆分，而不是拆成两个独立仓库或两个独立部署：

```text
src/client/     React、TanStack Router/Query、界面
src/server/     Hono、Better Auth、HTTP 边界、配置
src/domain/     Project、SandboxLease、AgentRun 的纯业务规则
src/application/ Project 与 AgentRun 用例、ports、RunCoordinator
src/runtime/    SandboxRuntime 合同与 fake/E2B/Container Adapter
src/agent/      AgentRuntime 合同、Pi 适配器和 registry
src/shared/     客户端与服务端共享 DTO
migrations/     D1 认证表与应用表迁移
worker/         Cloudflare Worker 入口
```

不同 Agent 可以按以上目录边界协作。`src/client` 不得导入 `src/server`，`src/domain` 不得依赖 Cloudflare、Hono、React 或 E2B SDK；`src/agent` 只依赖通用 `SandboxRuntime` 合同，不直接依赖具体供应商 SDK。

## 当前运行时状态

- D1 migration、Better Auth 邮箱密码客户端、Project API、Message 查询、单活跃 Run、SSE 和取消状态转换已经实现；SSE 在自己的请求内轮询 D1 的 Run 状态，页面刷新后可通过当前活跃 Run 查询恢复。
- `FakeSandboxRuntime` 用于无外部成本的 UI/控制面开发；`E2BSandboxRuntime` 支持真实 Linux、进程重连、精确进程终止和沙箱停止。
- Pi 是唯一已注册的 AgentRuntime，它把 `pi --mode rpc` JSONL 映射为统一 Agent 事件；fake runtime 不执行真实 Pi 二进制。
- `AgentRunWorkflow`、ModelGateway、Run capability、真实 usage、deadline 和空闲 TTL 已实现。远程 Workflows Free 的 10ms step CPU 上限仍需预览部署验证。
- 文件浏览、终端、preview、changes 和每用户并发上限尚未实现。
- Goose、Claude Code、Codex CLI 仅在 Runtime ID 合同中预留，尚未实现或暴露为选择项。
- 当前源码、迁移和 Worker binding 不包含 R2/Revision 路径；本地数据仍可按 ADR-0002 直接重建。

## 运行步骤

1. 安装依赖：`pnpm install`。
2. 在根目录创建本地 `.dev.vars`，填写 `BETTER_AUTH_SECRET`、`BETTER_AUTH_URL` 和 `GEMINI_API_KEY`。
3. 应用本地 D1 迁移：`pnpm wrangler d1 migrations apply DB --local`。
4. 启动：`pnpm dev`，Vite/Workers 本地地址为 `http://localhost:5173`。
5. 默认 `RUNTIME_PROVIDER` 为空时使用 fake；真实链路设置 `RUNTIME_PROVIDER=e2b`、`E2B_API_KEY`、`E2B_TEMPLATE_ID`，并为本地 E2B 提供可访问的 `MODEL_GATEWAY_BASE_URL`。
6. 验证：`pnpm typecheck && pnpm test && pnpm build`，并在浏览器完成注册、创建 Project、启动/取消 Run 的 smoke。

`wrangler.jsonc` 中的 D1 ID 是本地开发占位值。开始远程认证数据库迁移或部署前，只创建真实 D1 并替换 database ID；R2 不属于 V1。本项目不会自动创建任何云端资源。
