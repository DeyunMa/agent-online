# 2026-07-30 Sentry 与交付优化

> 类型：阶段验收与远程配置审计快照
>
> 范围：不新增产品能力，不修改 D1 schema，不引入第二个服务
>
> 关联：[当前架构](../reference/current-architecture.md) ·
> [环境变量](../setup/environment-variables.md) ·
> [Cloudflare 资源台账](../setup/cloudflare-preview-resources.md) ·
> [ADR-0008](../adr/0008-errors-and-execution-correlation.md)

## 1. 目标与结论

本阶段在既有错误码、`requestId`/`runId` 关联和 `DiagnosticReporter` 合同之上接入
Sentry Error Monitoring，并收敛此前审计发现的应用层、沙箱回收、前端状态和真实 E2E
成本问题。

结果保持原产品边界：

- 仍是 React + Hono 的单 Cloudflare Worker。
- Agent 仍运行在 E2B 沙箱内，`AgentRuntime` 与 `SandboxRuntime` 继续解耦。
- D1 仍是唯一产品数据库；没有 R2、事件表、raw transcript 或文件快照。
- Sentry 只提供可选错误观测，失败时不阻断 API、Workflow、Run 或 React 页面。
- 没有新增团队、支付、BYOK、公开 Goose 或管理后台能力。

## 2. Sentry 远程配置

| 项目 | 当前配置 |
| --- | --- |
| Organization | `dylandeyunma` |
| Project | `agent-online` |
| 启用能力 | Error Monitoring |
| 关闭能力 | Logs、Tracing、Application Metrics、Replay |
| Worker 环境 | `SENTRY_DSN` Cloudflare Secret；`SENTRY_ENVIRONMENT=preview` |
| React 构建 | 忽略的 `.env.preview.local` 提供 `VITE_SENTRY_DSN` 与 environment |
| Source Maps | Worker 与 React 两组 artifact bundle 已在 Sentry 页面核对 |
| 上传权限 | 仅 `org:ci` 的组织 token |
| 上传凭据位置 | 忽略且权限为 `0600` 的 `.env.sentry-build-plugin` |

Dashboard：

- [Issues](https://dylandeyunma.sentry.io/issues/?project=agent-online)
- [Source Maps](https://dylandeyunma.sentry.io/settings/projects/agent-online/source-maps/)

文档、Git 和构建输出均不保存 DSN 值、上传 token、账号密码或 Provider Key。

## 3. 代码接入点

| 层 | 接入 |
| --- | --- |
| Hono | 最早层安装官方 Sentry middleware；`onError` 手动捕获一次未处理异常，避免重复事件。 |
| Workflow | Worker 导出的 Cloudflare Workflow 使用官方 instrumentation 包装。 |
| Application/adapter | 结构化 console 与 Sentry Reporter 组合；只上报 error severity 的受控诊断事件。 |
| React | 入口初始化 SDK，并用 Error Boundary 显示不包含异常正文的恢复页。 |
| Build | Vite 插件只在显式 Preview deploy 上传隐藏源码映射，完成后删除 `dist/**/*.map`。 |

主要文件：

- `src/server/observability/sentry.ts`
- `src/server/observability/reporter.ts`
- `src/client/observability/sentry.ts`
- `src/client/components/client-error-fallback.tsx`
- `src/server/app.ts`
- `worker/index.ts`
- `vite.config.ts`

## 4. 数据边界

服务端和浏览器 `beforeSend` 都以 allowlist 重建事件。允许：

- exception type、stack、debug metadata；
- environment、release 和 SDK metadata；
- 固定 diagnostic event/code/stage；
- `requestId`、`runId`、Project/Session 应用 ID；
- Runtime/Model ID、状态、聚合 usage 和 duration 等受控数值。

禁止：

- prompt、Message/Agent 回复、文件内容和路径；
- Terminal/Preview/Changes 内容；
- Cookie、Authorization、capability、环境变量和 Key；
- 用户身份、Provider sandbox/process reference、内部 host/port；
- Provider response body、原始异常 message、breadcrumbs 和 request context。

Reporter 自身失败被隔离，不改变产品结果。D1 不保存 Sentry event 或 trace。

## 5. 架构加固

### 5.1 Owner-scoped 读取门面

新增 `ProjectReadService`，集中 Project、Message、Run 和 Lease 的所有者过滤读取；
`ServerServices` 不再把原始 repositories 暴露给 Hono。SandboxLease 批量读取按 D1
参数上限分块，避免 Project 列表形成 N+1 请求。

### 5.2 统一沙箱回收

新增 `SandboxReclaimer`，统一 Run idle、Terminal/Preview 释放后的 idle cleanup 和
手动 Stop。所有路径都先通过 D1 条件更新原子脱离 Provider reference，再调用 Provider
stop，避免不同用例分别维护竞争顺序。

### 5.3 前端活动状态

Project 活动状态拆成：

- 排他轴：`idle | run | terminal | preview_starting`；
- Preview 轴：`stopped | starting | running`。

这保留了 running Preview 可与后续 Run/Terminal 共存的产品合同，同时阻止 Preview
starting 的并发操作。Inspector 和 Run tabs 增加方向键、Home/End roving focus，并在
移动抽屉异步聚焦后恢复正确 tab 焦点。

## 6. E2B 模板修复

旧组合模板把 `/workspace` 建成 root-owned，真实 Terminal/Agent 使用 E2B 默认非 root
用户时会触发 Git `dubious ownership`，导致 Changes 不可用。

第三版模板改为：

1. root 创建 `/workspace`；
2. 将目录所有权交给 E2B 默认用户并设为 `0755`；
3. 显式以默认用户运行后续进程；
4. 模板探针实际验证写入、Git init/status 和沙箱中不存在模型/Provider Key。

Pi-only 回滚模板同步采用相同规则。真实组合模板 E2E 已完成
`Pi -> Goose -> Pi -> Goose cancel`，确认共享文件、最终回复、usage、精确取消和密钥
隔离没有回归。

## 7. Hosted E2E 成本优化

发布 E2E 仍保留三条浏览器路径，但只让基线路径创建两个 AgentRun：

- 一次真实 Pi 成功 Run 验证 Workflow、ModelGateway、最终 Message、usage 和 Files；
- 一次可取消长任务验证取消与刷新恢复；
- Project 生命周期用 Terminal 创建沙箱；
- Changes/Files/Preview 路径用 Terminal 创建确定性 Vite/Git fixture。

完整执行从四个 AgentRun 降为两个，同时仍使用三个独立 E2B 沙箱覆盖隔离、清理和
Project 删除。Terminal ready marker 改为仅在命令真正完成后输出，避免输入回显造成
假阳性。

## 8. 验证矩阵

| 验证 | 结果 |
| --- | --- |
| Sentry sanitizer 与 Reporter 单元测试 | 通过 |
| ProjectReadService、D1 批量 Lease、路由/API 测试 | 通过 |
| SandboxReclaimer、Run/Terminal/Preview 回收测试 | 通过 |
| Project activity 与 tab navigation 测试 | 通过 |
| Playwright 本地浏览器 smoke | 2 passed |
| 第三版 Pi/Goose 模板真实 E2E | 1 passed，约 65 秒 |
| 新模板 Hosted Terminal/Changes/Files/Preview 路径 | 1 passed，约 34 秒 |
| `pnpm check` 最终完整复跑 | 通过：248 unit passed / 1 skipped，7 D1 passed，2 browser passed |
| 最终部署三条 Hosted Preview E2E | 3 passed，约 1.2 分钟 |
| E2E 后远程协调预检 | 9 checks passed |

Cloudflare Preview 当前部署版本：
`50a111c7-1c22-4f80-8bca-0810fb772e84`。

最终 Hosted E2E 分别用时约 27.0、11.1 和 34.6 秒，验证真实 Pi 产品路径、
Project 重命名/硬删除与空闲 sandbox 停止，以及 Terminal/Changes/Files/Preview
确定性 fixture。Playwright 明确返回 `3 passed`；执行包装脚本随后误用 zsh 只读变量
`status`，只影响外层 shell exit code，不影响测试结果或资源清理。其后独立远程
preflight 九项全部通过。

## 9. 已知限制

1. 本阶段没有故意向远程 Sentry 发送 synthetic exception，避免给产品增加 debug
   route。事件清洗与捕获选项由单元测试覆盖，Cloudflare Secret 和两组源码映射由
   Dashboard 核对；首次真实异常仍需在后续人工试用时确认 Issues 入站。
2. Cloudflare Vite 的 Worker/React 双环境构建会让第二个源码映射上传阶段重新扫描已
   处理的 Worker 文件并输出缺少 `.map` 的 warning；两组 artifact bundle 均已成功
   上传，warning 不影响部署产物。
3. 当前 Sentry release 由构建时 Git HEAD 自动识别。本轮工作树尚未提交，因此 release
   标签不能单独证明部署包含全部未提交变更；debug ID 仍可匹配已上传源码映射。正式
   发布应先创建可追溯提交再部署。
4. React 主 bundle 仍有 Vite 大小 warning；Terminal 已单独分块，该 warning 当前不
   是正确性问题。

## 10. 回滚与删除

- 关闭上报：删除 Cloudflare `SENTRY_DSN` Secret，并移除本地
  `VITE_SENTRY_DSN`；产品功能继续运行。
- 停止源码映射上传：使用普通 build/dry-run，或移除本地上传凭据；不要把 token 改存
  到 Worker。
- 删除远程 Sentry Project、auth token 或 Cloudflare Secret 都是远程/安全敏感操作，
  仍需单独明确授权。

## 11. 官方依据

- [Sentry Cloudflare SDK](https://github.com/getsentry/sentry-javascript/blob/develop/packages/cloudflare/README.md)
- [Sentry Hono SDK](https://github.com/getsentry/sentry-javascript/blob/develop/packages/hono/README.md)
- [Sentry JavaScript Source Maps](https://docs.sentry.io/platforms/javascript/guides/cloudflare/sourcemaps/)
- [E2B User and Workdir](https://e2b.dev/docs/template/user-and-workdir)
- [E2B Defining a Template](https://e2b.dev/docs/template/defining-template)
