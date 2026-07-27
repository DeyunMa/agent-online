# Cloudflare Preview 资源台账

> 状态：本文记录截至 2026-07-27 的私有 Cloudflare 环境。架构加固代码和
> `0006_integrity_guards.sql` 已按锁定、预检、迁移、解锁顺序部署，并通过 Hosted
> Preview E2E。`0007_agent_run_failure_codes.sql` 目前只存在于本地代码，尚未应用到
> 远程 Preview。
> 本文只记录资源标识、变量名和查看路径，不记录 Secret 值或 owner 邮箱。

## 1. Account

| 项目 | 值 |
| --- | --- |
| Cloudflare Account ID | `66a06222aa0acd9ea509abad73fa02fb` |
| Workers 子域 | `mdy1145141.workers.dev` |
| Account 首页 | [Cloudflare Account Home](https://dash.cloudflare.com/66a06222aa0acd9ea509abad73fa02fb/home) |
| Workers 列表 | [Workers 和 Pages](https://dash.cloudflare.com/66a06222aa0acd9ea509abad73fa02fb/workers-and-pages) |

本机环境还存在指向其他 Account 的 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。对本 Preview 执行任何远程 Wrangler 命令时，必须排除旧 Token 并显式指定目标 Account：

```sh
env -u CLOUDFLARE_API_TOKEN \
  CLOUDFLARE_ACCOUNT_ID=66a06222aa0acd9ea509abad73fa02fb \
  pnpm wrangler whoami
```

看到目标 Account ID 后才允许迁移或部署。Wrangler 已通过 Cloudflare 官方 OAuth 连接该 Account；不要把 OAuth 凭据复制进仓库或 Worker Secret。

## 2. Worker

| 项目 | 值 |
| --- | --- |
| Worker 名称 | `agent-online-preview` |
| 公开 URL | [agent-online-preview.mdy1145141.workers.dev](https://agent-online-preview.mdy1145141.workers.dev) |
| 当前部署版本 | `c722c868-a0f0-4bfd-b2f4-97654d026bce` |
| Dashboard 概述 | [Worker Overview](https://dash.cloudflare.com/66a06222aa0acd9ea509abad73fa02fb/workers/services/view/agent-online-preview/production) |
| 变量与 Secret | [Worker Settings](https://dash.cloudflare.com/66a06222aa0acd9ea509abad73fa02fb/workers/services/view/agent-online-preview/production/settings#variables) |
| Binding | [Worker Bindings](https://dash.cloudflare.com/66a06222aa0acd9ea509abad73fa02fb/workers/services/view/agent-online-preview/production/bindings) |
| 部署版本 | [Worker Deployments](https://dash.cloudflare.com/66a06222aa0acd9ea509abad73fa02fb/workers/services/view/agent-online-preview/production/deployments) |
| 指标 | [Worker Metrics](https://dash.cloudflare.com/66a06222aa0acd9ea509abad73fa02fb/workers/services/view/agent-online-preview/production/metrics) |
| Observability | [Worker Observability](https://dash.cloudflare.com/66a06222aa0acd9ea509abad73fa02fb/workers/services/view/agent-online-preview/production/observability) |

Worker 同时提供 React Assets 和 Hono API。没有为本项目创建第二个 Worker、Pages 项目、自定义域或 Git 自动部署；Account 中原有的 `personal-site` Pages 项目与 Agent Online 无关。

## 3. D1

| 项目 | 值 |
| --- | --- |
| 数据库名称 | `agent-online-preview-db` |
| D1 ID | `f5b3193a-298b-4a61-a07b-24f5fc26c28e` |
| Worker Binding | `DB` |
| Dashboard | [D1 Metrics](https://dash.cloudflare.com/66a06222aa0acd9ea509abad73fa02fb/workers/d1/databases/f5b3193a-298b-4a61-a07b-24f5fc26c28e/metrics) |

远程 Preview 当前已应用迁移：

- `0001_app.sql`
- `0002_d2_run_execution.sql`
- `0003_provider_process_ref.sql`
- `0004_terminal_sessions.sql`
- `0005_preview_sessions.sql`
- `0006_integrity_guards.sql`

待发布：

- `0007_agent_run_failure_codes.sql`

`0006` 已在 `RUNS_ENABLED=false` 的锁定版本下应用。迁移前九项只读完整性预检全部为
零，迁移后先完成锁定 smoke，再恢复 Run。未来涉及执行顺序或 D1 trigger 的发布仍按
[私有 Preview 部署](./preview-deployment.md)执行。

D1 只保存 Better Auth、Project、Message、SandboxLease、AgentRun、聚合 usage，以及当前 Terminal/Preview 的临时协调行。Terminal/Preview 停止后对应行删除；Changes 不新增表，不保存 Git status/diff/history。没有创建 R2、KV、Durable Object 或文件快照。

## 4. Workflow

| 项目 | 值 |
| --- | --- |
| Workflow 名称 | `agent-online-preview-run` |
| Worker Binding | `AGENT_RUN_WORKFLOW` |
| Dashboard | [Workflow Instances](https://dash.cloudflare.com/66a06222aa0acd9ea509abad73fa02fb/workers/workflows/agent-online-preview-run/instances) |

打开 `RUNS_ENABLED` 后，受邀 owner 已通过该 Workflow 完成真实 AgentRun、Run 空闲回收，以及 Terminal/Preview expiry 与 idle cleanup 的持久调度。30 分钟 Terminal expiry 的完整等待未纳入远端 smoke，expiry claim 和调度失败路径由自动测试覆盖；Preview 另以 50 秒独立 Workflow smoke 验证了 sleep、expiry 与幂等释放步骤。

## 5. 非敏感变量

这些值由 `wrangler.jsonc` 的 `env.preview.vars` 管理，Dashboard 只用于查看：

| 名称 | 当前值 |
| --- | --- |
| `ACCESS_MODE` | `allowlist` |
| `BETTER_AUTH_URL` | `https://agent-online-preview.mdy1145141.workers.dev` |
| `DEFAULT_MODEL_ID` | `gemini-3.6-flash` |
| `E2B_TEMPLATE_ID` | `agent-online-pi-goose-runtime:8916fff0-6236-43ba-a397-b0e2b8f97c47` |
| `GOOSE_RUNTIME_MODE` | `spike` |
| `MAX_RUN_WALL_SECONDS` | `1800` |
| `RUNTIME_IDLE_TTL_SECONDS` | `600` |
| `RUNTIME_PROVIDER` | `e2b` |
| `RUNS_ENABLED` | `true` |

不要在 Dashboard 单独修改这些纯文本值；下一次 Wrangler 部署会以仓库配置为准。

截至 2026-07-27，本表记录的是当前已部署 Preview。第二版组合模板显式安装并探测
Node、Pi、Goose、Git、Bash 与 coreutils；`GOOSE_RUNTIME_MODE=spike` 已上线，
该模式允许受邀测试者显式调用 Goose，
但 `/api/capabilities` 和 UI 仍只公布 Pi。旧 Pi-only Provider sandbox 不会
随 Worker 配置原地升级；本次验收使用新 Project，让首个 Run 按组合模板创建沙箱。

## 6. 加密 Secret

以下 Secret 已在 Worker Settings 中以加密类型保存，Dashboard 不再显示其值：

- `ACCESS_ALLOWED_EMAILS`
- `BETTER_AUTH_SECRET`
- `E2B_API_KEY`
- `GEMINI_API_KEY`

`ACCESS_ALLOWED_EMAILS` 当前只包含 owner 邮箱，但本文不记录具体地址。`BETTER_AUTH_SECRET` 为 Preview 独立生成，没有复用本地开发 Secret。

## 7. Observability

Preview 在 `wrangler.jsonc` 中启用：

- Workers Logs：启用，100% head sampling，持久化 invocation logs。
- Workers Traces：关闭。
- 外部日志导出、Tail Worker 和 Sentry：未配置。

当前应用记录 Worker invocation，并在 Gemini 上游拒绝请求时增加受控协议诊断：只包含 HTTP 状态、错误类别、消息角色和工具/签名数量，不包含 prompt、消息正文、代码文件、终端输出、签名值或 Secret。Run/Preview 启动失败只记录安全阶段名和错误类名，不记录 Provider 标识、内部端口、签名 capability 或 config 内容。若以后增加日志字段，必须先复核该边界。

Cloudflare Workers Free 当前包含每天 200,000 条日志事件并保留 3 天；该额度和保留期可能变化，见 [Workers Logs 官方说明](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)。

## 8. 已完成 Smoke

Preview 已验证：

- `GET /api/health`：`200`。
- 锁定阶段 `GET /api/capabilities`：`200` 且 `runCreationEnabled=false`；打开 Run 后页面与 API 可创建执行。
- 未登录 `GET /api/projects`：`401`。
- 非 allowlist 邮箱注册：`403`。
- owner 邮箱注册、登录、Project 创建和远程页面恢复。
- 同一 Project 的 E2B 沙箱文件在连续 Run 间复用。
- Pi 在沙箱内执行文件读取工具，Gemini 经 Worker ModelGateway 完成两次模型请求并返回最终回复。
- D1 中 Run 状态为 `succeeded`，有一条最终 assistant Message，并记录实际 token、模型请求数和沙箱时长。
- 长时 shell 任务可从 UI 取消；D1 收敛为 `cancelled`、不写 assistant Message，后续 Run 可继续复用原沙箱文件。
- 临时将 Run wall clock 改为 8 秒后，长任务准确收敛为 `timed_out`；验收后已恢复正式值 `1800`。
- 恢复正式值后再次完成真实 Run；Workflow 实例中的 `execute agent run` 步骤配置已确认为 `timeout: 1830 seconds`，排除了临时 8 秒配置仍在传播的风险。
- 最终 Run 空闲 10 分钟后，Workflow 返回 `detached=true, stopped=true`；D1 Lease 收敛为 `stopped` 且不再保存 Provider 引用。
- 使用组合模板在同一 Project 完成 Pi 创建文件、Goose 修改、Pi 再验证；三次 Run 的最终 Message、Runtime ID 和真实 usage 均写入 D1。
- Goose 长 shell 的跨请求取消收敛为 `cancelled`；临时 8 秒 deadline 收敛为 `timed_out`，恢复 1800 秒后超过 8 秒的任务成功。
- 临时 8 秒空闲 TTL 的最新 Workflow 实例完成 sleep、原子脱离和停止；正式 TTL 已恢复为 600 秒。
- Files 在真实 E2B Lease 上完成目录和文本读取；空闲回收和手动 Stop 后显示明确停止状态，不创建新沙箱、不请求文件且不展示陈旧缓存。
- `/api/capabilities` 返回 `previewEnabled=true`；Project Inspector 只在现有 E2B Lease 上启动固定 `vite-v1`，浏览器不能传入 command、port、cwd、env 或 Provider URL。
- 真实 Preview 成功加载 V1 HTML/JS/CSS；保持 Preview 运行时完成 Pi Run 修改同一 `/workspace`，手动 Reload 后显示 V2，CSS 注入和 Vite 文件缓存失效均生效。
- Preview 运行时完成真实 Terminal 连接和文件读取；Run 与 Terminal 可复用同一沙箱，
  整沙箱 Stop 返回 `409 project.busy`。
- 显式停止 Preview 后临时 D1 行清空，随后手动 Stop 成功；最终 Lease 为 `stopped`，Provider 引用、PreviewSession 和 TerminalSession 均已清理。
- 独立 `preview-expiry` Workflow smoke 以 50 秒 future expiry 完成 sleep 与 release，返回 `released=false` 表示目标 Project 当时已无待释放 Preview，不影响 D1。
- `1440x900` 与 `390x844` 的干净浏览器会话均加载真实 V2 页面，控制台 0 error/warning；响应和 DOM 未出现 E2B host、sandbox ID、内部端口或 Key。
- `/api/capabilities` 返回 `changesEnabled=true`；真实 repository 的 modified、
  staged rename + unstaged modification、untracked、binary 和 128 KiB diff 截断均正确。
- 危险 `filter.*` 和 `.git/config.worktree` repository 配置均被拒绝，标记程序未
  执行；移走 `.git` 显示非 repository，恢复后 Changes 可继续读取。
- Changes 列表和详情均返回 `Cache-Control: private, no-store`，JSON 未出现
  Provider、E2B、内部端口或 Key 字段。
- 桌面三栏和 `390x844` Project Inspector 抽屉均显示真实 Changes；抽屉初始焦点、
  关闭恢复和 `390 -> 1230 -> 390` 断点复位通过。反斜线合法文件名显示部分变更隐藏，
  不误报 clean。
- 最后两次审计 Run `ae64b831`、`fd6123cb` 均使用 Pi +
  `gemini-3.6-flash` 成功，分别记录 29,871 / 12 和 11,471 / 5 的
  token / 模型请求；最终 Lease 为 `stopped`、Provider 引用清空，
  TerminalSession/PreviewSession 均为 0。
- 最终公开能力仍只有 Pi，未登录 Project API 为 `401`；D1 抽查未发现 Key/capability 名称，终态 Run/停止 Lease 的私有引用均已清空。
- 架构加固发布先以版本 `7c3bf620-9ec1-44d1-9d4d-78e51866c815` 锁定新 Run，
  迁移 `0006` 后恢复；最终可追溯版本为
  `c722c868-a0f0-4bfd-b2f4-97654d026bce`。
- Hosted Preview 自动 E2E 从真实登录开始，完成 Pi 写文件、最终 Message、usage、
  Files 读取、第二 Run 取消、刷新后一致性、沙箱停止和全部 JSON API 响应脱敏检查。
  完成后九项远程预检全部为零；11 条 Lease 全部为 `stopped`，保存 Provider 引用的
  Lease 为 0。

尚未验证：

- 更复杂任务下 Workflow Free 的 CPU 与 subrequest 限制。
- Goose capability 在子工具中的继承和精确输出/日志脱敏自动门禁。
- Goose 浏览器选择、刷新恢复和移动端交互。

验收期间产生的取消、超时和探针 Run 记录保留在 Preview D1 中，用于确认状态和 usage 收敛；它们不是生产数据。最终测试 Preview 和 Terminal 行均已删除，沙箱已通过手动 Stop 停止，Provider 引用已清空，文件按 V1 设计允许丢失。

## 9. 运维命令

应用远程迁移：

```sh
env -u CLOUDFLARE_API_TOKEN \
  CLOUDFLARE_ACCOUNT_ID=66a06222aa0acd9ea509abad73fa02fb \
  pnpm wrangler d1 migrations apply DB --remote --env preview
```

迁移前只读预检：

```sh
env -u CLOUDFLARE_API_TOKEN \
  CLOUDFLARE_ACCOUNT_ID=66a06222aa0acd9ea509abad73fa02fb \
  pnpm release:preview:preflight
```

部署 Preview：

```sh
env -u CLOUDFLARE_API_TOKEN \
  CLOUDFLARE_ACCOUNT_ID=66a06222aa0acd9ea509abad73fa02fb \
  pnpm deploy:preview
```

配置变更部署后，Worker binding 会先显示新值，Workflow 执行版本仍可能存在短暂传播窗口。涉及 timeout、TTL 或成本护栏的变更，不要立即以第一个实例下结论；先在 Workflow 实例详情核对 `step.do` 配置，再开始正式验收。

出现成本、授权或 Provider 异常时，把仓库中的 `RUNS_ENABLED` 改回 `"false"` 并重新部署。不要通过删除 Worker、D1 或 Workflow 处理普通故障。

顶层 production D1 和变量尚未配置。`pnpm deploy` 会被 production config guard 拒绝；
当前远程发布只能使用带显式 Account guard 的 `pnpm deploy:preview`。
