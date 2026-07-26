# Cloudflare 私有 Preview 部署

> 状态：2026-07-26 已完成锁定部署、真实 Pi AgentRun happy path、远程取消、deadline 和 10 分钟空闲回收。
> D2 代表性验收已完成；D3 Files 已在本地完成但尚未部署，后续能力仍应逐项部署和验收。
> 关联：[资源台账](./cloudflare-preview-resources.md) · [环境变量](./environment-variables.md) · [外部依赖](./external-dependencies.md) · [交付阶段与成本](../architecture/04-delivery-and-cost.md)

## 1. Preview 边界

Preview 是用于验证真实 Cloudflare Workflow、E2B 和 Pi 链路的受控环境，不是公开发布：

- 使用 `agent-online-preview` Worker 和独立的 `agent-online-preview-db` D1。
- `ACCESS_MODE=allowlist`，只有 `ACCESS_ALLOWED_EMAILS` 中的邮箱可以注册、登录和访问产品 API。
- 首次部署保持 `RUNS_ENABLED=false`。先验证认证、Project 和页面，再单独打开真实 AgentRun。
- 浏览器仍然不能得到 Gemini/E2B Key、Provider sandbox ID、内部端口或进程引用。
- Preview 与本地配置不共享 Binding、变量或 Secret；所有远程值都必须显式配置。

## 2. 提交前本地检查

以下命令不创建远程资源：

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm deploy:preview:dry-run
```

`pnpm deploy:preview:dry-run` 允许配置中保留远程占位值，以便先验证构建包和 Binding 结构。真实部署前，`pnpm validate:preview-config` 会拒绝：

- 全零的 Preview D1 `database_id`；
- 包含 `replace-me` 的 `BETTER_AUTH_URL`；
- 占位 E2B Template ID；
- 非 allowlist 的 Preview 访问模式；
- 非 E2B 的 Preview SandboxRuntime。

## 3. 创建远程资源

以下操作会读取或修改 Cloudflare 账号，执行前必须得到明确授权。当前 Preview 已完成这些步骤；保留本节作为重建和审计依据。

1. 确认 Wrangler 当前身份和目标 Account：

```sh
pnpm wrangler whoami
```

本机存在其他 Account 的 Cloudflare 环境变量，实际 Preview 命令必须使用[资源台账](./cloudflare-preview-resources.md)中的 Account guard。

2. 创建独立 Preview D1：

```sh
pnpm wrangler d1 create agent-online-preview-db
```

3. 将返回的真实 D1 ID 写入 `wrangler.jsonc` 的 `env.preview.d1_databases[0].database_id`。
4. 将 Preview Worker 的最终 HTTPS Origin 写入 `env.preview.vars.BETTER_AUTH_URL`。
5. 将已验证的精确 E2B build reference 写入 `env.preview.vars.E2B_TEMPLATE_ID`。
6. 验证非敏感配置：

```sh
pnpm validate:preview-config
```

不复用顶层 D1 占位配置，也不为 Preview 创建 R2、第二个 Worker 或第二套后端服务。

## 4. 写入 Preview Secret

每条命令通过终端交互输入值，不把值放进命令参数、Git 或文档：

```sh
pnpm wrangler secret put BETTER_AUTH_SECRET --env preview
pnpm wrangler secret put GEMINI_API_KEY --env preview
pnpm wrangler secret put E2B_API_KEY --env preview
pnpm wrangler secret put ACCESS_ALLOWED_EMAILS --env preview
```

`ACCESS_ALLOWED_EMAILS` 是逗号分隔的受邀邮箱。Preview 使用独立的 `BETTER_AUTH_SECRET`；`BETTER_AUTH_URL` 和 `E2B_TEMPLATE_ID` 是非敏感部署变量，不通过 Secret 写入。

## 5. 迁移并锁定部署

先应用远程迁移，再在 Run 关闭状态部署：

```sh
pnpm wrangler d1 migrations apply DB --remote --env preview
pnpm deploy:preview
```

锁定部署必须验证：

1. `/api/health` 正常。
2. `/api/capabilities` 返回 `runCreationEnabled: false`。
3. allowlist 邮箱可以注册、登录、创建和读取自己的 Project。
4. 非 allowlist 邮箱无法注册或登录。
5. 新建 Run 按钮和输入框禁用；直接调用创建 Run API 也返回 `runs_disabled`，且不写入 Message、Lease 或 AgentRun。

## 6. 打开真实 Run

锁定验收通过后，将 `env.preview.vars.RUNS_ENABLED` 改为 `"true"` 并再次执行 `pnpm deploy:preview`。随后只用受邀账号完成：

1. 创建 Project 并运行一个最小 Pi 任务。
2. 确认 Workflow 从 `queued` 收敛到终态，最终 assistant Message 和真实 usage 写入 D1。
3. 运行较长任务并取消，确认只终止当前 Pi 进程。
4. 再次运行，确认存活沙箱可复用；手动停止后确认 Project 文件允许丢失。
5. 等待空闲 TTL，确认旧 Lease 不会错误停止新 Run 正在使用的沙箱。
6. 检查 Cloudflare Workflow 的 step CPU、subrequest 和失败日志，决定 Free 计划是否能承载典型任务。

任何异常成本、授权或执行问题都先把 `RUNS_ENABLED` 改回 `"false"` 并重新部署，不删除远程数据或资源。

## 7. Preview 通过条件

- 私有访问和服务端 Run 开关均在真实 Worker 生效。
- 典型 Pi Run、取消、deadline、空闲 TTL 和沙箱停止均通过。
- Gemini Key 只在 Worker，E2B Key 只在 Worker 的 Sandbox Adapter。
- D1 中只出现产品状态和聚合 usage，不出现 Provider Key、raw transcript 或 Project 文件。
- Cloudflare Workflow 免费层的真实限制有实测结论。

完成以上条件后，D2 才算通过完整远程环境验收。只读 Files 已完成本地纵切，仍需在下一次 Preview 部署后使用真实 E2B Lease 验收；Terminal、Preview 和 Changes API 不因 Worker 已部署而提前开放。

当前已完成 owner 注册、Project 创建、同一沙箱文件复用、包含工具调用与多次 Gemini 请求的成功 Run、长任务取消，以及临时 8 秒 wall-clock 配置下的 `timed_out` 收敛。取消和超时均没有 assistant Message，后续 Run 仍能读取原文件。第 5 项已验证：10 分钟空闲 TTL 后 Workflow 返回 `detached=true, stopped=true`，D1 Lease 变为 `stopped` 并清空 Provider 引用。未单独点击手动 Stop；自动回收已验证同一停止路径，Project 测试文件按 V1 设计允许丢失。
