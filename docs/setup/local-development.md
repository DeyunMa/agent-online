# 本地开发基线

> 状态：目标架构基线 v0.4
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

- `FakeSandboxRuntime` 用于本地单元测试，模拟通用进程事件。
- Pi 是唯一已注册的 AgentRuntime，它把 `pi --mode rpc` 映射为统一 Agent 事件。
- 当前不是已启动的真实 Pi、E2B、终端、preview 或 ModelGateway 环境。
- Goose、Claude Code、Codex CLI 仅在 Runtime ID 合同中预留，尚未实现或暴露为选择项。
- 当前源码和迁移仍含早期 R2/Revision 骨架；下一实现阶段应按 ADR-0002 重建它们，不应把旧结构当作当前行为。

## 运行步骤

1. 安装依赖：`pnpm install`。
2. 在根目录创建本地 `.dev.vars`，填写 `BETTER_AUTH_SECRET`、`BETTER_AUTH_URL` 和 `GEMINI_API_KEY`。
3. 应用本地 D1 迁移：`pnpm wrangler d1 migrations apply DB --local`。
4. 启动：`pnpm dev`，Vite/Workers 本地地址为 `http://localhost:5173`。
5. 验证：`pnpm typecheck && pnpm test && pnpm build`。

`wrangler.jsonc` 中的 D1 ID 是本地开发占位值。开始远程认证数据库迁移或部署前，只创建真实 D1 并替换 database ID；R2 不属于 V1。当前旧 R2 Binding 必须随下一次架构实现一起移除，本项目不会自动创建任何云端资源。
