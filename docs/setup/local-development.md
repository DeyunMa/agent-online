# 本地开发基线

## 工程形态

Pi Online 只有一个可部署产品：React SPA 静态资源和 Hono API 同域运行在一个 Cloudflare Worker。源码按职责拆分，而不是拆成两个独立仓库或两个独立部署：

```text
src/client/     React、TanStack Router/Query、界面
src/server/     Hono、Better Auth、HTTP 边界、配置
src/domain/     Project、SandboxLease 的纯业务规则
src/runtime/    SandboxRuntime 合同与 fake/E2B/Container Adapter
src/agent/      Pi RPC 合同
src/shared/     客户端与服务端共享 DTO
migrations/     D1 认证表与应用表迁移
worker/         Cloudflare Worker 入口
```

不同 agent 可以在上述目录按边界工作；`src/client` 不得导入 `src/server`，`src/domain` 不得依赖 Cloudflare、Hono、React 或 E2B SDK。

## 运行步骤

1. 安装依赖：`pnpm install`。
2. 在根目录创建本地 `.dev.vars`，填写 `BETTER_AUTH_SECRET`、`BETTER_AUTH_URL` 和 `GEMINI_API_KEY`。
3. 启动：`pnpm dev`，Vite/Workers 本地地址为 `http://localhost:5173`。
4. 验证：`pnpm typecheck && pnpm test && pnpm build`。

`wrangler.jsonc` 中的 D1 ID 是本地开发占位值，尚未创建远程资源。开始认证数据库迁移或远程部署前，先单独创建真实 D1/R2 资源并替换 Binding 配置；本轮不会自动创建云端资源。
