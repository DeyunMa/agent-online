# Agent Online

> 状态：D2 真实执行纵切已部署到私有 Cloudflare Preview（2026-07-26）
> 当前 Preview 已完成 Worker、Assets、D1、Workflow、加密 Secret、邮箱白名单，以及真实 Pi AgentRun 的 happy path、取消、deadline 和空闲 TTL；受控文件、终端、preview 尚未完成。
> 下一阶段：D3 先实现受控只读 Files，再依次实现用量聚合、Terminal 和 Preview。

Agent Online 是一个开源、个人开发的 Hosted Coding Agent 学习项目。用户在浏览器中注册、创建 Project、启动隔离 Linux 沙箱，并通过受控界面使用 Agent、终端、文件和 preview。

它参考 CCOnline 的产品边界：真实 Agent 进程运行在远程沙箱，浏览器只是控制和可视化界面。它不复制 CCOnline、Pi、Claude Code、Codex 或任何第三方的代码、品牌和商业实现。

## V1 架构结论

- 一个仓库、一个 Cloudflare Worker 部署单元：React 静态资源和 Hono API 同域；不拆分前后端项目。
- `User -> Project -> SandboxLease` 是资源关系。一个 Project 只有一个逻辑沙箱记录，并在同一时刻最多对应一个真实 Provider 沙箱。
- `Project` 是用户看见的代码项目和对话容器，不单独建 Session 表。真实沙箱停止、过期或故障后，Project 文件可以丢失；第一版不恢复它们。
- `AgentRun` 是一次短生命周期的 Agent 执行，通常对应一个用户回合。一个 Project 同时最多一个非终态 `AgentRun`；多个连续 Run 可以复用仍存活的沙箱文件系统。
- `SandboxRuntime` 管理 Provider 沙箱和通用进程；`AgentRuntime` 管理 Pi 等 Agent 协议；两者是可替换代码边界，不是额外微服务。
- Agent 在沙箱内运行，Hono Worker 在沙箱外负责鉴权、D1、Run 编排、事件脱敏和 `ModelGateway`。Gemini Key 永远不进入浏览器或沙箱。
- D1 是唯一的 V1 持久化存储，保存认证、Project 元数据、用户可见消息、AgentRun 状态和聚合用量。R2 不属于 V1。

## 当前实现

- Better Auth 邮箱密码注册/登录，用户直接拥有 Project。
- Pi 是唯一注册的 AgentRuntime；`FakeSandboxRuntime` 用于无外部成本的本地控制面开发，`E2BSandboxRuntime` 提供真实进程、文件写入、精确进程终止和沙箱停止。
- D1 持久化认证、Project、用户输入、最终 assistant Message、Lease、Run 状态和聚合 usage；一个 Project 同时最多一个非终态 Run。
- 每个真实 Run 由一个 Cloudflare Workflow 拥有。Workflow 参数只有应用级 Project/Run ID，提示词从 D1 回读。
- Pi 通过短时 Run capability 调用 Worker ModelGateway。Gemini Key、E2B Key、Provider sandbox ID 和进程引用不会进入浏览器或持久日志。
- 取消优先只终止当前 Pi 进程并保留 Project 沙箱；deadline 和执行所有者丢失会让 Run 收敛到明确终态；空闲清理使用 D1 条件更新避免停止新 Run 正在使用的沙箱。
- SSE 当前发布 D1 Run 状态和终态。最终回复在 Run 完成后从 Message API 读取；不持久化 raw Pi transcript 或私有推理。
- 私有 Preview 支持邮箱 allowlist 和服务端 `RUNS_ENABLED` 总开关；关闭时浏览器和创建 Run API 同时拒绝新执行，且不写入 Message、Lease 或 AgentRun。

远程 Preview 已验证包含沙箱工具调用、多次 Gemini 请求、最终 assistant Message 和真实 usage 的 Pi Run，也验证了长任务取消只终止当前 Pi 进程、沙箱可继续复用，并用临时 8 秒配置验证了 `timed_out` 收敛。10 分钟空闲 TTL 到期后，Workflow 已原子脱离并停止 E2B 沙箱，D1 清除了 Provider 引用。手动 Stop UI 和更复杂任务下的 Workflows 免费层限额仍需单独验收。受控文件浏览、终端、preview、changes 和用户用量页属于后续纵切，UI 在对应 API 完成前必须保持禁用或不展示。

D2 的架构、表结构、远程证据、外部依赖和成本结论已冻结在 [2026-07-26 D2 阶段基线](./docs/status/2026-07-26-d2-baseline.md)。后续文档中的“当前状态”以该基线和更晚的阶段记录为准。

执行所有权、取消和 TTL 设计见 [ADR-0003](./docs/adr/0003-agent-run-workflow.md)。

## 明确不做

- R2 Project 文件快照、文件版本、回滚、沙箱历史、原始 Agent transcript 或长期终端日志。
- 团队、组织、Tenant、Membership 或共享 Project。
- 套餐、价格、订阅、支付、充值、发票、退款和税务。
- BYOK、第三方登录、公开 Runtime 选择，或把 Goose、Claude Code、Codex CLI 的名称当作已支持功能。
- 每条消息新建沙箱，或为每个 Project 永久保留一个物理沙箱。

计量仍在范围内，但它服务于成本观察、用户展示和以后接计费，不是商业账单系统。

## 依赖边界

V1 的产品数据基础设施只有 D1；Project 文件只存在于沙箱。运行时还依赖 Cloudflare Worker/Assets/Workflows、Gemini API 和一个 Sandbox Provider（当前为 E2B）。Better Auth 是 Worker 内的库，不是另一个托管服务；Sentry 是可选观测工具，不是功能依赖。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [CONTEXT.md](./CONTEXT.md) | 当前统一术语、资源关系和不变量。 |
| [ADR-0002](./docs/adr/0002-run-agent-process-and-lease-lifecycle.md) | 已接受的轻量 V1 数据、运行和沙箱边界。 |
| [ADR-0003](./docs/adr/0003-agent-run-workflow.md) | 每个 AgentRun 一个 Workflow 的执行、取消、TTL 和恢复边界。 |
| [系统总览](./docs/architecture/01-system-overview.md) | 单 Worker 请求流与浏览器、Worker、Agent、沙箱之间的数据路径。 |
| [沙箱与 Agent 运行时](./docs/architecture/02-sandbox-runtime.md) | `SandboxLease` 生命周期、`SandboxRuntime` 与 `AgentRuntime` 的合同。 |
| [数据、认证与模型](./docs/architecture/03-data-auth-and-models.md) | D1、Better Auth、Gemini 网关、AgentRun 用量与可选观测。 |
| [阶段与成本](./docs/architecture/04-delivery-and-cost.md) | fake/E2B/Cloudflare 的推进方式和成本护栏。 |
| [视觉与产品目标](./docs/design/visual-product-target.md) | 已确认的工作台视觉基准、真实数据原则和分阶段功能映射。 |
| [环境变量](./docs/setup/environment-variables.md) | 当前需要的 Key、Binding 和可选配置。 |
| [外部依赖与待补充项](./docs/setup/external-dependencies.md) | 代码之外的账号、Secret、远程资源和用户待确认事项。 |
| [本地开发](./docs/setup/local-development.md) | 单 Worker 工程结构、模块边界和本地启动方式。 |
| [Cloudflare 私有 Preview 部署](./docs/setup/preview-deployment.md) | Preview 白名单、Run 开关、D1/Secret/迁移和分阶段验收步骤。 |
| [Cloudflare Preview 资源台账](./docs/setup/cloudflare-preview-resources.md) | 已创建资源、Dashboard 查看路径、变量/Secret 名称、日志与运维命令。 |
| [E2B + Pi + Gemini Spike](./docs/testing/e2b-pi-gemini-spike.md) | 显式启用的真实 Provider 可行性验证，不等同于 D2 产品实现。 |
| [2026-07-26 D2 阶段基线](./docs/status/2026-07-26-d2-baseline.md) | 当前架构、D1 表、远程验收、成本与 D3 实施顺序。 |
| [ADR-0001（历史）](./docs/adr/0001-user-project-sandbox-boundary.md) | 已被 ADR-0002 取代的旧基线，保留供决策追溯。 |

## 审计顺序

先审阅 [ADR-0002](./docs/adr/0002-run-agent-process-and-lease-lifecycle.md) 和 [CONTEXT.md](./CONTEXT.md)，再审阅运行时、数据和环境变量文档。后续实现以这套合同为准；本地开发数据和迁移可以重建，不为历史 R2/Revision 骨架保留兼容路径。
