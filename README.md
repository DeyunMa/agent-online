# Agent Online

> 状态：架构与工程基线 v0.3（2026-07-25）
> 当前实现：单 Worker 骨架、D1 迁移、通用沙箱合同、Pi 默认 AgentRuntime 与 fake runtime 测试；尚未接入真实沙箱或真实 Pi 进程。

Agent Online 是一个开源、可自托管的 Coding Agent SaaS 学习项目。用户在浏览器中登录、创建代码 Project、启动隔离 Linux 沙箱，并通过受控界面使用 Agent、终端、文件编辑和 preview。

它参考 CCOnline 的产品边界：真实 Agent 进程运行在云沙箱，浏览器只是控制与可视化界面。它不复制 CCOnline、Pi、Claude Code、Codex 或任何第三方的代码、品牌和商业实现。

## 架构结论

- 只有一个产品仓库和一个 Cloudflare Worker 部署单元：React 静态资源与 Hono API 同域。
- `User -> Project -> SandboxLease` 是第一版的资源关系；不建立团队、组织或 Tenant。
- `SandboxRuntime` 只负责沙箱创建、恢复、通用进程执行、快照和停止。
- `AgentRuntime` 负责把一个 Agent 的协议映射为通用沙箱命令和统一事件。当前唯一已注册实现是 Pi，默认模型设计为 Gemini。
- `Project.default_agent_runtime_id` 决定默认 Agent；`Run.agent_runtime_id` 固化一次实际执行选择。未来可增加 Goose、Claude Code 或 Codex CLI 适配器，但没有适配器、能力声明和安全审计前，它们不是产品选项。
- 浏览器只得到应用自己的 `sandboxLeaseId`、状态、脱敏事件和受控 preview；供应商 sandbox ID、端口和密钥始终留在服务端。

## 当前范围

- Better Auth 邮箱密码注册/登录，用户直接拥有 Project。
- 一个 Project 活动期间最多一个临时沙箱；多个连续 Run 复用它。
- 停止后将工作区 Revision 和事件归档到 R2，以 D1 指针恢复。
- 平台 Gemini、以后 BYOK、多模型、用量计量、用户级配额和安全熔断。
- Pi 是默认且唯一已注册的 AgentRuntime；当前只验证 fake sandbox 下的合同，不宣称真实 Pi 已上线。

## 明确不做

- 团队、组织、`Tenant`、Membership 或共享 Project。
- 套餐、价格、订阅、支付、充值、发票、退款和税务。
- 浏览器直接获取 E2B / Cloudflare 的真实 sandbox ID、内部端口或密钥。
- 每条消息新建沙箱，或为每个 Project 永久保留一个沙箱。
- 把 Goose、Claude Code 或 Codex CLI 的名称当作已经可用的运行时。

计量和配额仍在范围内：它们用于限制资源、保护平台 Key 和控制沙箱成本，并不构成商业计费系统。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [CONTEXT.md](./CONTEXT.md) | 用户、项目、沙箱、AgentRuntime、运行和用量的统一术语。 |
| [系统总览](./docs/architecture/01-system-overview.md) | 产品边界、单 Worker 部署和一次 Agent Run 的请求流。 |
| [沙箱与 Agent 运行时](./docs/architecture/02-sandbox-runtime.md) | `SandboxLease` 生命周期、双运行时边界、Pi 默认适配器和供应商适配。 |
| [数据、认证与模型](./docs/architecture/03-data-auth-and-models.md) | Better Auth、D1/R2、Gemini、BYOK、运行时选择、计量与配额。 |
| [阶段与成本](./docs/architecture/04-delivery-and-cost.md) | fake/E2B/Cloudflare 的推进方式、AgentRuntime 扩展和非目标。 |
| [环境变量](./docs/setup/environment-variables.md) | 当前需要的 Key、Worker Binding 和本地配置方式。 |
| [本地开发](./docs/setup/local-development.md) | 单 Worker 工程结构、模块边界和本地启动方式。 |
| [ADR-0001](./docs/adr/0001-user-project-sandbox-boundary.md) | 最难逆转的领域与运行时决策。 |

## 审计顺序

先审阅 [CONTEXT.md](./CONTEXT.md) 和 [ADR-0001](./docs/adr/0001-user-project-sandbox-boundary.md)，确认 `User -> Project -> SandboxLease` 以及 `SandboxRuntime` / `AgentRuntime` 的职责。之后再审阅环境变量、供应商选择和实现阶段。
