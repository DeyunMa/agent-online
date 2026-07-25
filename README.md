# Agent Online

> 状态：目标架构基线 v0.4（2026-07-25）
> 当前代码仍保留早期的 R2/Revision 脚手架；本文档和 ADR-0002 是下一轮实现、迁移重建与代码清理的目标合同。真实沙箱和真实 Pi 进程尚未接入。

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

## V1 范围

- Better Auth 邮箱密码注册/登录，用户直接拥有 Project。
- Pi 是唯一实际注册的 AgentRuntime，默认模型为平台 Gemini。
- 一个 Project 一个临时沙箱，允许连续 Run 复用仍存活的工作区；空闲 TTL 或 Provider 停止后释放。
- D1 保存用户/最终助手消息，以及每个 `AgentRun` 的 token、模型请求数、沙箱时长、状态和失败原因，供基础用户展示和内部管理汇总。
- 浏览器只获得应用自己的 `sandboxLeaseId`、状态、受控事件和 preview；真实 sandbox ID、端口、Provider 凭据和 Gemini Key 始终留在服务端。

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

先审阅 [ADR-0002](./docs/adr/0002-run-agent-process-and-lease-lifecycle.md) 和 [CONTEXT.md](./CONTEXT.md)，再审阅运行时、数据和环境变量文档。实现前应以这套 v0.4 合同重建本地迁移和删除旧 R2/Revision 骨架，不为本地历史数据保留兼容路径。
