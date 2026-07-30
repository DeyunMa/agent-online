# Agent Online

> 状态：D2 真实执行、D3 受控 Files/Usage/Terminal/Preview/Changes、Project 生命周期和 D4 Goose 私有 spike 均已完成既定验收。2026-07-30 已接入脱敏 Sentry Error Monitoring，并完成 v4 Workspace 模板、平台 Preview 工具链和桌面三栏拖动布局；Goose 仍不向浏览器公开，配额、BYOK 和公开注册仍不在当前实现中。

Agent Online 是一个开源、个人开发的 Hosted Coding Agent 学习项目。用户在浏览器中注册、创建 Project、启动隔离 Linux 沙箱，并通过受控界面使用 Agent、终端、文件、preview 和当前 Git changes。

它参考 CCOnline 的产品边界：真实 Agent 进程运行在远程沙箱，浏览器只是控制和可视化界面。它不复制 CCOnline、Pi、Claude Code、Codex 或任何第三方的代码、品牌和商业实现。

## V1 架构结论

- 一个仓库、一个 Cloudflare Worker 部署单元：React 静态资源和 Hono API 同域；不拆分前后端项目。
- `User -> Project -> SandboxLease` 是资源关系。一个 Project 只有一个逻辑沙箱记录，并在同一时刻最多对应一个真实 Provider 沙箱。
- `Project` 是用户看见的代码项目和对话容器，不单独建 Session 表。真实沙箱停止、过期或故障后，Project 文件可以丢失；第一版不恢复它们。
- `AgentRun` 是一次短生命周期的 Agent 执行，通常对应一个用户回合。一个 Project 同时最多一个非终态 `AgentRun`；多个连续 Run 可以复用仍存活的沙箱文件系统。
- `SandboxRuntime` 按生命周期、进程、文件、终端、Preview 和只读 Changes 能力提供窄接口；`AgentRuntime` 管理 Pi 等 Agent 协议；两者是可替换代码边界，不是额外微服务。
- Agent 在沙箱内运行，Hono Worker 在沙箱外负责鉴权、D1、Run 编排、事件脱敏和 `ModelGateway`。Gemini Key 永远不进入浏览器或沙箱。
- D1 是唯一的 V1 持久化存储，保存认证、Project 元数据、用户可见消息、AgentRun 状态、
  聚合用量、已删除 Project 的最小 per-Run usage 归档，以及当前 Terminal/Preview 的
  临时协调行。R2 不属于 V1。

## 当前实现

- Better Auth 邮箱密码注册/登录，用户直接拥有 Project。
- Project 支持受所有权保护的重命名和硬删除。删除会拒绝活动 Run、Terminal 或 Preview，
  先停止空闲沙箱，在同一 D1 batch 中归档最小 Run usage，再级联删除 Message、
  AgentRun 和 Lease；不提供回收站。
- Pi 是默认且已验收的 AgentRuntime；Goose 第二 Runtime 已按 ADR-0004 完成本地和私有 Preview spike，但继续由服务端门控且不出现在 UI。`FakeSandboxRuntime` 用于无外部成本的本地控制面开发，且明确不提供跨请求 Files；`E2BSandboxRuntime` 提供真实进程、受控文件读写、精确进程终止和沙箱停止。
- D1 持久化认证、Project、用户输入、最终 assistant Message、Lease、Run 状态和聚合 usage；一个 Project 同时最多一个非终态 Run。成功终态、sandbox duration、最终 assistant Message 和 Project touch 在一个 D1 batch 中完成，取消竞态不会留下成功回复。
- 普通产品 API 使用统一的点分错误码、HTTP/retryable 映射和 `requestId`；AgentRun 持久化稳定 `failureCode`。结构化日志使用 `requestId` 定位一次请求、使用已有 `runId` 关联创建、Workflow、ModelGateway、取消、终态和 idle cleanup。Preview 还启用了同一窄 `DiagnosticReporter` 外层的 Sentry Error Monitoring；两条路径都不记录用户内容或 Provider 私有值。
- 普通产品 mutation 在进入鉴权和 JSON 解析前统一要求同源，并限制请求体为 256 KiB；API 与静态资源分别设置安全响应头，构建门禁会校验 `_headers` 未丢失。
- 每个真实 Run 由一个 Cloudflare Workflow 拥有。Workflow 参数只有应用级 Project/Run ID，提示词从 D1 回读。
- Pi 通过短时 Run capability 调用 Worker ModelGateway。单次上游模型请求有 120 秒 deadline 且不自动重放非幂等 POST；Gemini Key、E2B Key、Provider sandbox ID 和进程引用不会进入浏览器或持久日志。
- 取消优先只终止当前 Agent 进程并保留 Project 沙箱；deadline 和执行所有者丢失会让 Run 收敛到明确终态；空闲清理使用 D1 条件更新避免停止新 Run 正在使用的沙箱。
- SSE 当前发布 D1 Run 状态和终态。最终回复在 Run 完成后从 Message API 读取；不持久化 raw Pi transcript 或私有推理。
- 私有 Preview 支持邮箱 allowlist 和服务端 `RUNS_ENABLED` 总开关；关闭时浏览器和创建 Run API 同时拒绝新执行，且不写入 Message、Lease 或 AgentRun。
- Project Inspector 已启用只读 Files：仅附着现有 E2B Lease，限制在 `/workspace`，拒绝路径穿越、`.git`、符号链接、二进制和超大文本；活动 Run 期间不读取文件。
- 已实现认证后的 `GET /api/usage` 和响应式 Usage 页面，按当前 `user_id` 合并现存
  AgentRun 与已删除 Project 的最小 per-Run usage 归档，返回总量、Project 和
  AgentRuntime 用量；没有价格或计费对象。
- Project Inspector 已启用受控 Terminal：登录用户通过同源 Worker WebSocket 使用当前 E2B `/workspace` PTY；D1 只保存当前硬互斥和私有 sandbox/PTY reference，不保存滚屏。Terminal 与 AgentRun 互斥，30 分钟 expiry 与关闭后的 10 分钟 idle 回收都由 Workflow 持久调度。
- Project Inspector 已启用受控 Preview：只在现有 E2B Lease 中运行
  `/opt/agent-online/preview` 的平台固定 Vite 和端口，通过同源、短时签名的 GET/HEAD
  网关加载 HTML/JS/CSS。启动前识别缺少 `index.html` 和已声明但未安装的项目依赖；
  浏览器不能提交命令、端口、环境变量或 Provider URL。Preview 最长 30 分钟，停止即
  删除临时 D1 行，不保存页面、日志、截图或访问历史。
- Project Inspector 已启用只读 Changes：仅在现有 E2B Lease 中读取 `/workspace` 当前 Git working tree/index，使用固定 Git 命令、清空进程环境、拒绝危险或额外的 repository config scope，并分别展示 staged/unstaged 的有界 diff。不能安全公开的路径会明确标记为隐藏，不会误报 working tree clean。它不保存历史，也不能把变更归因到某一次 Run。
- `pnpm check` 统一执行依赖方向、源码凭据扫描、Biome lint/format、严格 TypeScript、Node 单元测试、Cloudflare Workers 真实 D1 迁移/触发器测试、production build/产物凭据与静态安全头校验，以及 Playwright 浏览器 smoke。GitHub Actions 在 `main` 和 Pull Request 上执行同一门禁；真实 E2B/Gemini E2E 保持显式 opt-in，避免每次提交产生沙箱成本。
- 顶层 production 资源尚未配置，通用 `pnpm deploy` 会被配置 guard 拒绝；当前远程
  目标只有带显式 Cloudflare Account guard 的私有 Preview。`0006` 与 `0007` 均已按
  锁定、九项只读 D1 完整性预检、迁移和解锁顺序发布；同一流程保留为后续 trigger
  变更的发布门禁。
- Goose 已作为独立 adapter 接入门控 registry；Pi + Goose 组合 E2B 模板已在本地 adapter 和远端产品路径完成 `Pi -> Goose -> Pi`、D1、最终 Message、usage、取消、deadline、空闲回收与 Key 隔离验收。浏览器 Runtime 选择和 capability/工具继承输出脱敏复核尚未完成，因此公开产品能力仍是 Pi-only。
- 当前 E2B 组合模板固定以非 root 用户运行，并让该用户拥有 `/workspace`。模板探针会验证目录可写、Git 初始化与 status 可用，避免 Terminal/Agent 创建的 repository 因所有权不一致触发 Git `safe.directory` 拒绝。
- Project 查询经 application `ProjectReadService` 统一执行 owner scope；Run 空闲回收、
  Terminal/Preview 释放后的回收和手动停止复用同一 `SandboxReclaimer`。客户端将排他
  活动与可并行的 running Preview 分成两个状态轴，并支持桌面/移动端 tab 键盘导航。
  桌面端左栏固定，中栏和 Project Inspector 之间可通过分隔条拖动或键盘调整，宽度偏好
  保存在当前浏览器；移动端继续使用检查器抽屉。
- Sentry 只启用 Error Monitoring。React、Hono 和 Workflow 异常经过严格 allowlist 清洗后上报；Logs、Tracing、Replay、Metrics 和用户内容采集均关闭。Preview 部署上传隐藏源码映射，上传后从 `dist` 删除 `.map`。

Cloudflare 私有环境已验证包含沙箱工具调用、多次 Gemini 请求、最终 assistant Message 和真实 usage 的 Pi/Goose Run；长任务取消只终止当前 Agent 进程，临时 8 秒配置可准确收敛为 `timed_out`，恢复 1800 秒后长任务再次成功。临时 8 秒空闲 TTL 验证了 Workflow 原子脱离并停止组合模板沙箱；正式值已恢复为 600 秒。Files 已验证真实目录和文本、停止状态、手动停止以及停止后不显示陈旧缓存。Terminal 已验证真实 `/workspace` PTY、Run/Files/Stop 硬互斥、文件跨 Terminal/Pi Run 连续、显式关闭和断线清理。Project Preview 已验证真实 HTML/JS/CSS、Agent 修改后的手动刷新、与 Run/Terminal 并行、活动时阻止整沙箱 Stop、显式停止和 Workflow expiry。Changes 已验证 mixed staged/unstaged、rename、binary、untracked、大 diff 截断、主配置与 worktree config 拒绝、隐藏路径提示、非 repository 状态、no-store 与公开响应脱敏；桌面三栏、移动端检查器抽屉和跨响应式断点状态均通过真实浏览器验收。Goose 选择器仍须保持禁用或不展示。

2026-07-30 的 v4 Preview 平台底座与可调检查器版本已部署到私有 Cloudflare Preview；
当前 Worker 版本为 `772c6b92-b294-4741-9b61-ef4c6db82468`，并已包含标签页 favicon
和桌面三栏横向分隔线对齐修复。
当前试用入口仍为 allowlist 私有环境，不代表已经开放公共注册；最新完整验收结果记录在
[2026-07-30 Preview 平台底座与可调检查器](./docs/status/2026-07-30-preview-platform-and-resizable-inspector.md)。

D2 的架构、表结构、远程证据、外部依赖和成本结论已冻结在 [2026-07-26 D2 阶段基线](./docs/status/2026-07-26-d2-baseline.md)。不扩展功能的正确性与工程门禁调整见 [2026-07-27 架构与工程门禁加固](./docs/status/2026-07-27-architecture-hardening.md)，交付收敛见 [2026-07-28 交付加固](./docs/status/2026-07-28-delivery-hardening.md)，Project 生命周期结果见 [2026-07-28 Project 生命周期](./docs/status/2026-07-28-project-lifecycle.md)，最近 Sentry 与架构收敛结果见 [2026-07-30 Sentry 与交付优化](./docs/status/2026-07-30-sentry-and-delivery-optimization.md)。这些 `status` 文档是阶段验收证据；判断当前事实时按 [文档使用说明](./docs/README.md) 的优先级，以代码、迁移、测试和 `reference` 文档为准。

执行所有权、取消和 TTL 设计见 [ADR-0003](./docs/adr/0003-agent-run-workflow.md)。

## 明确不做

- R2 Project 文件快照、文件版本、回滚、沙箱历史、原始 Agent transcript 或长期终端日志。
- 团队、组织、Tenant、Membership 或共享 Project。
- 套餐、价格、订阅、支付、充值、发票、退款和税务。
- BYOK、第三方登录、未验收的公开 Runtime 选择，或把 Goose、Claude Code、Codex CLI 的名称直接当作已支持功能。
- 每条消息新建沙箱，或为每个 Project 永久保留一个物理沙箱。

计量仍在范围内，但它服务于成本观察、用户展示和以后接计费，不是商业账单系统。

## 依赖边界

V1 的产品数据基础设施只有 D1；Project 文件只存在于沙箱。运行时还依赖 Cloudflare Worker/Assets/Workflows、Gemini API 和一个 Sandbox Provider（当前为 E2B）。Better Auth 是 Worker 内的库，不是另一个托管服务；Sentry 已用于 Preview 错误监控，但不是产品功能或执行链路的可用性前提。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [文档使用说明](./docs/README.md) | 当前事实、ADR、状态快照和视觉文档的优先级与维护规则。 |
| [CONTEXT.md](./CONTEXT.md) | 当前统一术语、资源关系和不变量。 |
| [当前项目架构](./docs/reference/current-architecture.md) | 当前部署拓扑、资源模型、代码分层、执行流和信任边界。 |
| [D1 表设计](./docs/reference/database-schema.md) | 当前全部 D1 表、字段、外键、索引、状态和删除语义。 |
| [HTTP、SSE 与 WebSocket 接口](./docs/reference/http-api.md) | 当前产品 API、公开 DTO、错误模型和流协议。 |
| [平台限制与限制对象](./docs/reference/platform-limits.md) | 当前硬限制、互斥矩阵、产品边界、外部限制和剩余风险。 |
| [ADR-0002](./docs/adr/0002-run-agent-process-and-lease-lifecycle.md) | 已接受的轻量 V1 数据、运行和沙箱边界。 |
| [ADR-0003](./docs/adr/0003-agent-run-workflow.md) | 每个 AgentRun 一个 Workflow 的执行、取消、TTL 和恢复边界。 |
| [ADR-0004](./docs/adr/0004-goose-agent-runtime-spike.md) | Goose 独立 adapter、组合模板、模型通道与产品启用门槛。 |
| [ADR-0005](./docs/adr/0005-controlled-project-terminal.md) | Project Terminal 的 PTY capability、同源 WebSocket、D1 互斥和回收。 |
| [ADR-0006](./docs/adr/0006-controlled-project-preview.md) | 固定 Vite Preview、同源签名内容网关、临时 D1 所有权和回收。 |
| [ADR-0007](./docs/adr/0007-controlled-project-changes.md) | 固定 Git 命令、危险配置拒绝、有界 status/diff 和当前工作树语义。 |
| [ADR-0008](./docs/adr/0008-errors-and-execution-correlation.md) | `requestId/runId` 关联、公共/持久化/诊断错误分层与结构化日志。 |
| [ADR-0009](./docs/adr/0009-project-rename-and-hard-delete.md) | Project 重命名、活动资源拒绝、空闲沙箱停止与无回收站硬删除。 |
| [系统总览](./docs/architecture/01-system-overview.md) | 单 Worker 请求流与浏览器、Worker、Agent、沙箱之间的数据路径。 |
| [沙箱与 Agent 运行时](./docs/architecture/02-sandbox-runtime.md) | `SandboxLease` 生命周期、`SandboxRuntime` 与 `AgentRuntime` 的合同。 |
| [数据、认证与模型](./docs/architecture/03-data-auth-and-models.md) | D1、Better Auth、Gemini 网关、AgentRun 用量与脱敏错误观测。 |
| [阶段与成本](./docs/architecture/04-delivery-and-cost.md) | fake/E2B/Cloudflare 的推进方式和成本护栏。 |
| [视觉与产品目标](./docs/design/visual-product-target.md) | 已确认的工作台视觉基准、真实数据原则和分阶段功能映射。 |
| [环境变量](./docs/setup/environment-variables.md) | 当前需要的 Key、Binding 和可选配置。 |
| [外部依赖与待补充项](./docs/setup/external-dependencies.md) | 代码之外的账号、Secret、远程资源和用户待确认事项。 |
| [本地开发](./docs/setup/local-development.md) | 单 Worker 工程结构、模块边界和本地启动方式。 |
| [Cloudflare 私有 Preview 部署](./docs/setup/preview-deployment.md) | Preview 白名单、Run 开关、D1/Secret/迁移和分阶段验收步骤。 |
| [Cloudflare Preview 资源台账](./docs/setup/cloudflare-preview-resources.md) | 已创建资源、Dashboard 查看路径、变量/Secret 名称、日志与运维命令。 |
| [协调状态恢复](./docs/operations/coordination-recovery.md) | stale Run/Terminal/Preview/Lease 的诊断、停止顺序和受控恢复边界。 |
| [E2B + Pi/Goose + Gemini E2E](./docs/testing/e2b-agent-runtimes-gemini.md) | 组合模板、两种 adapter、同沙箱文件连续性、usage 与取消的真实验证。 |
| [Hosted Preview E2E](./docs/testing/hosted-preview-e2e.md) | 从登录 UI 到真实 Pi、Files、usage、取消、停止和响应脱敏的发布后验收。 |
| [2026-07-26 D2 阶段基线](./docs/status/2026-07-26-d2-baseline.md) | 当前架构、D1 表、远程验收、成本与 D3 实施顺序。 |
| [2026-07-26 D3 Files 纵切](./docs/status/2026-07-26-d3-files.md) | 只读 Files 的合同、限制、测试、浏览器验收与剩余风险。 |
| [2026-07-26 D3 Usage 纵切](./docs/status/2026-07-26-d3-usage.md) | 当前用户全量用量聚合、API/UI 合同、本地验收与剩余边界。 |
| [2026-07-26 D3 Terminal 纵切](./docs/status/2026-07-26-d3-terminal.md) | 受控 PTY、同源 WebSocket、临时 D1 占用、UI 和验收记录。 |
| [2026-07-26 D3 Preview 纵切](./docs/status/2026-07-26-d3-preview.md) | 固定 Vite Preview、同源内容网关、生命周期、真实 E2E 与剩余限制。 |
| [2026-07-26 D3 Changes 纵切](./docs/status/2026-07-26-d3-changes.md) | 只读 Git status/diff、安全边界、远程 E2E、响应脱敏与移动端抽屉。 |
| [2026-07-26 D4 Goose Spike](./docs/status/2026-07-26-d4-goose-spike.md) | Goose adapter、组合模板、真实 E2E、门控状态与剩余产品验收。 |
| [2026-07-27 架构与工程门禁加固](./docs/status/2026-07-27-architecture-hardening.md) | Run/D1 原子性、模块边界、资源上限、凭据扫描和统一自动化门禁。 |
| [2026-07-27 Preview 发布与 Hosted E2E](./docs/status/2026-07-27-preview-release.md) | 锁定迁移、部署版本、完整产品 E2E 和最终远程清理证据。 |
| [2026-07-27 错误语义与结构化日志](./docs/status/2026-07-27-errors-and-observability.md) | 统一错误合同、Run failure code、执行关联、Preview 发布与验收结果。 |
| [2026-07-28 交付加固](./docs/status/2026-07-28-delivery-hardening.md) | HTTP 边界、上游 deadline、运行时模块拆分、严格类型和最终本地门禁。 |
| [2026-07-28 Project 生命周期](./docs/status/2026-07-28-project-lifecycle.md) | Project 重命名、空闲沙箱停止、硬删除、移动端菜单和最新 Preview E2E。 |
| [2026-07-30 Sentry 与交付优化](./docs/status/2026-07-30-sentry-and-delivery-optimization.md) | Sentry 配置与脱敏边界、应用层和回收模块加固、模板权限修复、低成本 E2E 与验收证据。 |
| [2026-07-30 Preview 平台底座与可调检查器](./docs/status/2026-07-30-preview-platform-and-resizable-inspector.md) | v4 E2B 工具链、平台固定 Vite、Preview 预检、桌面面板宽度调整与线上 E2E。 |
| [ADR-0001（历史）](./docs/adr/0001-user-project-sandbox-boundary.md) | 已被 ADR-0002 取代的旧基线，保留供决策追溯。 |

## 审计顺序

先审阅 [ADR-0002](./docs/adr/0002-run-agent-process-and-lease-lifecycle.md) 和 [CONTEXT.md](./CONTEXT.md)，再审阅运行时、数据和环境变量文档。后续实现以这套合同为准；本地开发数据和迁移可以重建，不为历史 R2/Revision 骨架保留兼容路径。
