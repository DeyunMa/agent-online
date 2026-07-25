# 交付阶段、运行时选择与成本边界

> 状态：架构与工程基线 v0.3
> 关联：[系统总览](./01-system-overview.md) · [运行时](./02-sandbox-runtime.md) · [环境变量](../setup/environment-variables.md)

## 1. 结论

Cloudflare Free 可以承担 React 静态资源、Hono 控制平面、D1、R2 和本地验证的起点；它不能承担 Cloudflare Containers 形式的生产 Linux 沙箱。开发期先用 fake runtime 和 E2B，后期再增加 Cloudflare Container Adapter。

项目是开源、可自托管的完整 Agent 产品实现，但支付/订阅完全不在范围内。用量和用户级配额只服务于安全、成本控制和可观测性。

运行时有两条独立演进轴：`SandboxRuntime` 决定 Linux 沙箱来自哪里，`AgentRuntime` 决定沙箱中启动什么 Agent。不要用一个 Provider 配置同时决定两者。

```mermaid
flowchart LR
    F["fake SandboxRuntime\n快速测试"] --> E["E2B Adapter\n真实远程开发"]
    E --> C["Cloudflare Container Adapter\n以后部署候选"]
    P["Pi AgentRuntime\n当前唯一注册项"] --> N["新增 AgentRuntime\n单独验收后接入"]
    F --> X["同一 User -> Project -> SandboxLease 合同"]
    E --> X
    C --> X
    P --> X
    N --> X
```

## 2. 阶段

| 阶段 | 目标 | 必做 | 不做 | 通过条件 |
| --- | --- | --- | --- | --- |
| D0 | 核心契约验证 | Hono、fake SandboxRuntime、Pi AgentRuntime mock、D1/R2 fixture。 | 邮件服务、E2B、BYOK。 | Project 与 Lease 状态机、进程/Agent 事件映射、失败恢复、用量幂等通过。 |
| D1 | 单用户产品闭环 | Better Auth 邮箱密码登录、Project、Message、Run、Lease、R2 Revision、默认 Gemini、用量页。 | 团队、支付、公开 BYOK、第三方登录。 | 用户注册登录、创建 Project、以 Pi 创建 Run、关闭后恢复。 |
| D2 | 真实远程沙箱 | E2B Adapter、真实 Pi、终端事件、preview、超时和停机。 | 公开无限注册。 | 同 Project 连续 Run 复用 Lease；停机后可冷恢复。 |
| D3 | 第二个 AgentRuntime | 一个独立 Runtime 适配器、能力矩阵、凭据流、取消/恢复与隔离 E2E。 | 同时接入多个 CLI。 | 不能假定 Pi 特性；不支持的能力明确降级。 |
| D4 | 可信模型接入 | ModelGateway、CredentialLease、BYOK 加密和审计。 | 支付、价格或订阅。 | Key 不落浏览器、沙箱、日志或 R2；租约可撤销。 |
| D5 | 公共部署候选 | Cloudflare Container Adapter、强制网络策略、管理熔断与完整 E2E。 | 商业计费系统。 | 成本上限、恢复、隔离与异常演练通过。 |

## 3. 当前与未来 Runtime 的边界

- `fake`：测试 `RunCoordinator`、重复事件、超时、R2 checkpoint 和配额。
- `e2b`：开发测试真实 Pi、Linux、终端、preview 和断线恢复；`E2B_API_KEY` 只在服务端环境中使用。
- `cloudflare-container`：以后需要 Cloudflare 原生生产 Runtime 时接入；不要因为其名称而把业务层绑定到 Containers。
- Pi：当前唯一已注册的 AgentRuntime。它是默认路径，但真实 Pi 沙箱执行尚未完成。
- Goose、Claude Code、Codex CLI：后续候选。只有达到 D3 的单独验收条件后，才可在 Project 或 Run UI 中出现。

## 4. 成本与滥用护栏

1. 每个 User 默认最多一个活动 Lease，配置化而非硬编码。
2. 每个 Run 有最大 wall-clock 时间、模型请求数和预留预算。
3. 空闲 TTL 到期时 checkpoint 并停止，避免 Project 因打开标签页长期占用沙箱。
4. R2 仅在可解释的 checkpoint 写入，不按 token 或终端字符保存。
5. 出现异常用量、Provider 错误或计量失败时，全局或用户级熔断新 Run。
6. 早期真实沙箱只对自己或受邀测试账号开放；不要以“开源”作为开放匿名计算资源的理由。
7. 每个新 AgentRuntime 都独立评估镜像体积、冷启动、模型请求路径和凭据持有方式；不能沿用 Pi 的成本假设。

## 5. 支付不是延后实现项，而是范围外

本仓库不设计：

- 价格和套餐；
- credit / 充值余额；
- 订阅生命周期；
- 支付、退款、发票、税务和 webhook；
- Stripe 或任何支付 Provider。

若未来需要商业化，应在独立 ADR 中从 `UsageEvent` 重新设计，不把商业对象提前混进 Project、Lease 或权限模型。

## 6. 上线前复核

成本、配额和产品可用性会变化。准备启用远程 Runtime 或公开注册前，复核：

- [Cloudflare Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare R2 定价](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare Containers](https://developers.cloudflare.com/containers/) 与 [定价](https://developers.cloudflare.com/containers/pricing/)
- [E2B Pricing](https://e2b.dev/pricing) 与 [Billing and limits](https://e2b.dev/docs/billing)
