# Pi Online

> 状态：架构基线 v0.2（2026-07-24）
> 仓库状态：仅含设计与配置契约，尚未实现应用代码。

Pi Online 是一个开源、可自托管的 Pi Coding Agent 产品实现。用户在浏览器中登录、创建代码项目、启动一个隔离 Linux 沙箱，并在其中使用 Pi、终端、文件编辑和预览。

它参考 CCOnline 的产品效果和边界：真实 Agent 进程运行在云沙箱，浏览器只提供控制与可视化界面。它不复制 CCOnline、Claude Code 或任何第三方的代码、品牌和商业实现。

## 第一版范围

- 邮箱密码注册/登录、用户直接拥有项目。
- 一个项目在活动期间最多拥有一个临时沙箱。
- Pi 在沙箱中运行；终端、文件、预览和 Pi Run 复用活动沙箱。
- 沙箱停止后，项目文件和历史由 D1/R2 恢复。
- 默认 Gemini、BYOK、多模型、用量计量、用户级配额与安全熔断。
- Hono 控制平面和 React 前端同域部署在一个 Cloudflare Worker。

## 明确不做

- 团队、组织、`Tenant`、Membership 或共享项目。
- 套餐、价格、订阅、支付、充值、发票、退款和税务。
- 浏览器直接获取 E2B / Cloudflare 的真实 sandbox ID、内部端口或密钥。
- 每条消息新建沙箱，或为每个项目永久保留一个沙箱。

计量和配额仍在范围内：它们用于限制资源、保护平台 Key 和控制沙箱成本，并不构成商业计费系统。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [CONTEXT.md](./CONTEXT.md) | 用户、项目、沙箱、运行和用量的统一术语。 |
| [系统总览](./docs/architecture/01-system-overview.md) | 产品边界、单 Worker 部署和请求流。 |
| [沙箱运行时](./docs/architecture/02-sandbox-runtime.md) | `SandboxLease` 生命周期、Pi、终端、预览和供应商适配。 |
| [数据、认证与模型](./docs/architecture/03-data-auth-and-models.md) | Better Auth、D1/R2、Gemini、BYOK、计量与配额。 |
| [阶段与成本](./docs/architecture/04-delivery-and-cost.md) | 本地/E2B/Cloudflare 的推进方式和非目标。 |
| [环境变量](./docs/setup/environment-variables.md) | 用户需提供的 Key、Worker Binding 和本地配置方式。 |
| [本地开发](./docs/setup/local-development.md) | 单 Worker 工程结构、模块边界和本地启动方式。 |
| [ADR-0001](./docs/adr/0001-user-project-sandbox-boundary.md) | 最难逆转的领域与运行时决策。 |

## 审计顺序

先审阅 [CONTEXT.md](./CONTEXT.md) 和 [ADR-0001](./docs/adr/0001-user-project-sandbox-boundary.md)。确认 `User -> Project -> SandboxLease` 后，再审阅环境变量和实现阶段。
