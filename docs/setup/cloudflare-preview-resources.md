# Cloudflare Preview 资源台账

> 状态：2026-07-26 已创建 Preview，`RUNS_ENABLED=true`，真实 Pi AgentRun、取消、deadline 和空闲 TTL 已通过。
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
| 当前部署版本 | `df7a9361-c101-41cc-93b9-2011894fc4ec` |
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

已应用迁移：

- `0001_app.sql`
- `0002_d2_run_execution.sql`
- `0003_provider_process_ref.sql`

D1 只保存 Better Auth、Project、Message、SandboxLease、AgentRun 和聚合 usage。没有创建 R2、KV、Durable Object 或文件快照。

## 4. Workflow

| 项目 | 值 |
| --- | --- |
| Workflow 名称 | `agent-online-preview-run` |
| Worker Binding | `AGENT_RUN_WORKFLOW` |
| Dashboard | [Workflow Instances](https://dash.cloudflare.com/66a06222aa0acd9ea509abad73fa02fb/workers/workflows/agent-online-preview-run/instances) |

锁定部署验收时实例数为 0。打开 `RUNS_ENABLED` 后，受邀 owner 已通过该 Workflow 完成真实 AgentRun。

## 5. 非敏感变量

这些值由 `wrangler.jsonc` 的 `env.preview.vars` 管理，Dashboard 只用于查看：

| 名称 | 当前值 |
| --- | --- |
| `ACCESS_MODE` | `allowlist` |
| `BETTER_AUTH_URL` | `https://agent-online-preview.mdy1145141.workers.dev` |
| `DEFAULT_MODEL_ID` | `gemini-3.6-flash` |
| `E2B_TEMPLATE_ID` | `agent-online-pi-runtime:885fa807-3bd8-4cae-9532-afa0d6c71986` |
| `MAX_RUN_WALL_SECONDS` | `1800` |
| `RUNTIME_IDLE_TTL_SECONDS` | `600` |
| `RUNTIME_PROVIDER` | `e2b` |
| `RUNS_ENABLED` | `true` |

不要在 Dashboard 单独修改这些纯文本值；下一次 Wrangler 部署会以仓库配置为准。

截至 2026-07-26，本表记录的是当前已部署 Preview。仓库已将下一次部署候选
`E2B_TEMPLATE_ID` 更新为经过本地真实 E2E 的
`agent-online-pi-goose-runtime:130dc6f0-e4d5-4e0f-9682-9142f115b2a8`，
但尚未执行 Cloudflare 部署；`GOOSE_RUNTIME_MODE` 也尚未在 Preview 启用。
旧 Pi-only Provider sandbox 不会随 Worker 配置原地升级。组合模板上线后的
Goose 验收必须使用新 Project，或先从 Project Inspector 停止旧 sandbox，
让下一次 Run 按新的精确模板重建。

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

当前应用记录 Worker invocation，并在 Gemini 上游拒绝请求时增加受控协议诊断：只包含 HTTP 状态、错误类别、消息角色和工具/签名数量，不包含 prompt、消息正文、代码文件、终端输出、签名值或 Secret。Run 启动失败只记录安全阶段名，不记录 Provider 标识。若以后增加日志字段，必须先复核该边界。

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

尚未验证：

- 手动 Stop UI；
- 当前本地已完成的只读 Files API 与 UI 尚未部署到该 Preview；
- 更复杂任务下 Workflow Free 的 CPU 与 subrequest 限制。

验收期间产生的失败 Run 记录保留在 Preview D1 中，用于确认错误状态和 usage 收敛；它们不是生产数据。未点击手动“Stop sandbox”；最终 smoke 沙箱由 10 分钟空闲 TTL 自动停止，文件按 V1 设计允许丢失。

## 9. 运维命令

应用远程迁移：

```sh
env -u CLOUDFLARE_API_TOKEN \
  CLOUDFLARE_ACCOUNT_ID=66a06222aa0acd9ea509abad73fa02fb \
  pnpm wrangler d1 migrations apply DB --remote --env preview
```

部署 Preview：

```sh
env -u CLOUDFLARE_API_TOKEN \
  CLOUDFLARE_ACCOUNT_ID=66a06222aa0acd9ea509abad73fa02fb \
  pnpm deploy:preview
```

配置变更部署后，Worker binding 会先显示新值，Workflow 执行版本仍可能存在短暂传播窗口。涉及 timeout、TTL 或成本护栏的变更，不要立即以第一个实例下结论；先在 Workflow 实例详情核对 `step.do` 配置，再开始正式验收。

出现成本、授权或 Provider 异常时，把仓库中的 `RUNS_ENABLED` 改回 `"false"` 并重新部署。不要通过删除 Worker、D1 或 Workflow 处理普通故障。
