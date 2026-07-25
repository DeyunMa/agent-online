# Agent Online

> 状态：D1 + fake P1 控制面已落地（2026-07-25）
> 当前可验收的是邮箱密码认证、Project、单活跃 fake Run、SSE 和取消；真实沙箱、真实 Pi 进程、模型网关、最终助手回复和真实计量仍未接入。

Agent Online 是一个开源、个人开发的 Hosted Coding Agent 学习项目。用户在浏览器中注册、创建 Project、启动隔离 Linux 沙箱，并通过受控界面使用 Agent、终端、文件和 preview。

它参考 CCOnline 的产品边界：真实 Agent 进程运行在远程沙箱，浏览器只是控制和可视化界面。它不复制 CCOnline、Pi、Claude Code、Codex 或任何第三方的代码、品牌和商业实现。

## V1 架构结论

- 一个仓库、一个 Cloudflare Worker 部署单元：React 静态资源和 Hono API 同域；不拆分前后端项目。
- `User -> Project -> SandboxLease` 是资源关系。一个 Project 只有一个逻辑沙箱记录，并在同一时刻最多对应一个真实 Provider 沙箱。
- `Project` 是用户看见的工作空间和对话容器，不单独建 Session 表。真实沙箱停止、过期或故障后，工作区文件可以丢失；第一版不恢复它们。
- `AgentRun` 是一次短生命周期的 Agent 执行，通常对应一个用户回合。一个 Project 同时最多一个非终态 `AgentRun`；多个连续 Run 可以复用仍存活的沙箱文件系统。
- `SandboxRuntime` 管理 Provider 沙箱和通用进程；`AgentRuntime` 管理 Pi 等 Agent 协议；两者是可替换代码边界，不是额外微服务。
- Agent 在沙箱内运行，Hono Worker 在沙箱外负责鉴权、D1、Run 编排、事件脱敏和 `ModelGateway`。Gemini Key 永远不进入浏览器或沙箱。
- D1 是唯一的 V1 持久化存储，保存认证、Project 元数据、用户可见消息、AgentRun 状态和聚合用量。R2 不属于 V1。

## 当前 P1 范围

- Better Auth 邮箱密码注册/登录，用户直接拥有 Project。
- Pi 是唯一实际注册的 AgentRuntime，但只通过 `FakeSandboxRuntime` 验证受控进程合同。
- D1 持久化认证、Project、用户输入、Lease、Run 状态和零值 usage；一个 Project 同时最多一个非终态 Run。
- 浏览器只获得应用自己的 `sandboxLeaseId`、Run 状态和脱敏 fake 事件；真实 sandbox ID、端口、Provider 凭据和 Gemini Key 始终留在服务端。

当前 fake P1 只持久化用户输入、Run 生命周期和零值聚合用量；可信的最终助手消息和真实 token/时长要等 Pi RPC 与 ModelGateway 接通后再写入，不能用 fake 终端输出冒充模型回复。

fake P1 的 SSE 在订阅请求内轮询 D1，只发布 Run 状态和终态，不转发原始 Agent 输出。取消先持久化为 `cancelling`；fake 协调器会在进程完成时收敛为 `cancelled`，不承诺即时物理终止、跨 isolate 协调或 Worker 重启后的恢复。真实长生命周期沙箱前必须先完成对应的持久协调设计。

空闲 TTL、Run 超时和每用户活动沙箱上限是 D2 真实运行时护栏，不是 fake P1 已实现的能力。

## D2 目标（尚未实现）

- E2B SandboxRuntime、真实 Pi RPC、Worker ModelGateway 和最终 assistant Message。
- 真实 token、模型请求数和沙箱时长写入 `AgentRun`；再提供用户基础用量视图。
- 同一存活沙箱上的连续 Run、受控终端、文件和 preview；沙箱停止后工作区不恢复。

## 明确不做

- R2 工作区快照、文件版本、回滚、沙箱历史、原始 Agent transcript 或长期终端日志。
- 团队、组织、Tenant、Membership 或共享 Project。
- 套餐、价格、订阅、支付、充值、发票、退款和税务。
- BYOK、第三方登录、公开 Runtime 选择，或把 Goose、Claude Code、Codex CLI 的名称当作已支持功能。
- 每条消息新建沙箱，或为每个 Project 永久保留一个物理沙箱。

计量仍在范围内，但它服务于成本观察、用户展示和以后接计费，不是商业账单系统。

## 依赖边界

V1 的产品数据基础设施只有 D1；工作区只存在于沙箱。运行时还依赖 Cloudflare Worker/Assets 托管、Gemini API 和一个 Sandbox Provider（本地真实验证优先 E2B）。Better Auth 是 Worker 内的库，不是另一个托管服务；Sentry 是可选观测工具，不是功能依赖。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [CONTEXT.md](./CONTEXT.md) | 当前统一术语、资源关系和不变量。 |
| [ADR-0002](./docs/adr/0002-run-agent-process-and-lease-lifecycle.md) | 已接受的轻量 V1 数据、运行和沙箱边界。 |
| [系统总览](./docs/architecture/01-system-overview.md) | 单 Worker 请求流与浏览器、Worker、Agent、沙箱之间的数据路径。 |
| [沙箱与 Agent 运行时](./docs/architecture/02-sandbox-runtime.md) | `SandboxLease` 生命周期、`SandboxRuntime` 与 `AgentRuntime` 的合同。 |
| [数据、认证与模型](./docs/architecture/03-data-auth-and-models.md) | D1、Better Auth、Gemini 网关、AgentRun 用量与可选观测。 |
| [阶段与成本](./docs/architecture/04-delivery-and-cost.md) | fake/E2B/Cloudflare 的推进方式和成本护栏。 |
| [环境变量](./docs/setup/environment-variables.md) | 当前需要的 Key、Binding 和可选配置。 |
| [本地开发](./docs/setup/local-development.md) | 单 Worker 工程结构、模块边界和本地启动方式。 |
| [ADR-0001（历史）](./docs/adr/0001-user-project-sandbox-boundary.md) | 已被 ADR-0002 取代的旧基线，保留供决策追溯。 |

## 审计顺序

先审阅 [ADR-0002](./docs/adr/0002-run-agent-process-and-lease-lifecycle.md) 和 [CONTEXT.md](./CONTEXT.md)，再审阅运行时、数据和环境变量文档。后续实现以这套合同为准；本地开发数据和迁移可以重建，不为历史 R2/Revision 骨架保留兼容路径。
