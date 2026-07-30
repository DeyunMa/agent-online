# 交付阶段、运行时选择与成本边界

> 状态：D2、D3 与 D4 Goose 私有 spike 已完成既定验收；2026-07-30 完成 Sentry Error Monitoring、应用层/回收模块、前端活动状态、E2B 工作区所有权和低成本 Hosted E2E 加固。公开能力仍受门控。
> 关联：[ADR-0002](../adr/0002-run-agent-process-and-lease-lifecycle.md) · [ADR-0003](../adr/0003-agent-run-workflow.md) · [ADR-0004](../adr/0004-goose-agent-runtime-spike.md) · [ADR-0005](../adr/0005-controlled-project-terminal.md) · [ADR-0006](../adr/0006-controlled-project-preview.md) · [ADR-0007](../adr/0007-controlled-project-changes.md) · [系统总览](./01-system-overview.md) · [运行时](./02-sandbox-runtime.md) · [环境变量](../setup/environment-variables.md)

## 1. 结论

Cloudflare Worker/Assets 和 D1 是 V1 平台基线；R2 不在第一版。真实 Linux 沙箱是独立运行时依赖：本地和早期真实验证优先用 E2B，未来若迁移 Cloudflare Containers，仍保持同一 `SandboxRuntime` 合同并在当时复核产品可用性与价格。

项目是开源、个人学习用的完整 Agent 产品实现，但支付/订阅完全不在范围内。D1 上的 Run 用量只服务于产品展示、内部观察和将来的计费接口准备。

运行时有两条独立演进轴：`SandboxRuntime` 决定 Linux 沙箱来自哪里，`AgentRuntime` 决定沙箱中启动什么 Agent。不要用一个 Provider 配置同时决定两者。

```mermaid
flowchart LR
    F["fake SandboxRuntime\n快速测试"] --> E["E2B Adapter\n真实远程开发"]
    E --> C["Cloudflare Container Adapter\n以后部署候选"]
    P["Pi AgentRuntime\n默认且已验收"] --> G["Goose AgentRuntime\n门控 spike"]
    G --> N["其他 Runtime\n独立 ADR 后再评估"]
    F --> X["同一 User -> Project -> SandboxLease 合同"]
    E --> X
    C --> X
    P --> X
    N --> X
```

## 2. 阶段

| 阶段 | 目标 | 必做 | 不做 | 通过条件 |
| --- | --- | --- | --- | --- |
| D0 | 重建轻量合同 | 按 ADR-0002 清理 R2/Revision 模型，重建 D1 迁移、领域合同与 fake 测试。 | 真实 Provider、真实模型、BYOK。 | 单 Lease、单活动 AgentRun、文件不恢复和状态机测试通过。 |
| D1 | fake 控制面闭环 | Better Auth 邮箱密码登录、Project、用户输入、AgentRun、Lease、SSE、取消与零值 usage UI。 | 团队、支付、公开 BYOK、第三方登录、伪造 assistant 回复。 | 注册登录、创建 Project、fake Pi Run、取消和 D1 Run 状态可见。 |
| D2 | 真实 Agent 路径 | 按 ADR-0003 实现 AgentRunWorkflow、Gemini ModelGateway、E2B Adapter、真实 Pi、最终回复、取消、deadline 和 TTL。 | 匿名开放注册、R2 恢复、raw event 归档。 | 同 Project 连续 Run 复用存活沙箱；取消/TTL 收敛；远程 Workflow 免费层运行通过。 |
| D3 | 受控 Project 能力与用量观察 | Files、当前用户 Usage、Terminal、Preview 和 Changes。 | 任意 shell 公共入口、日志全量归档、管理后台和商业计费。 | 受控能力通过授权、互斥、输出上限、响应脱敏和真实 E2E。 |
| D3H | 工程加固 | D1 原子完成/跨表 trigger、ModelGateway 上限、路由/协议分层、真实 D1 测试、lint/format、凭据扫描、浏览器 smoke。 | 新产品能力。 | 本地与 CI 使用同一 `pnpm check`。 |
| D4 | 第二个 Runtime 或 Provider | 一个独立适配器、能力矩阵、凭据流、取消和隔离 E2E。 | 同时接入多个 CLI。 | 不假定 Pi 特性；不支持的能力明确拒绝。 |
| D5 | 公共部署候选 | 重新审阅注册滥用、限额、网络策略、成本上限和完整 E2E。 | 支付系统。 | 真实成本、异常路径和隔离演练通过。 |

当前进度：D0/D1/D2 已完成。D2 已实现并远程验证 E2B、Pi RPC、ModelGateway、最终 assistant Message、真实 usage、私有进程取消、Run deadline、Workflow 重试恢复、原子空闲回收、部署邮箱 allowlist 和全局 Run 开关。D3 只读 Files、当前用户全量 Usage API/UI、受控 Terminal、受控 Project Preview 与只读 Changes 均已完成授权边界、代码、测试、部署和远端真实浏览器验收。Preview 已验证固定 Vite、同源 GET/HEAD 网关、Agent 修改后刷新、Run/Terminal 并行、Stop 互斥、显式停止和 Workflow expiry；Changes 已验证固定 Git、主配置与额外 config scope 拒绝、隐藏路径标记、有界 staged/unstaged diff、no-store、显式响应映射和移动端检查器抽屉。D4 已完成 Goose adapter、服务端门控、组合模板，以及 D1/Workflow/usage/取消/deadline/TTL 的私有 Cloudflare spike；Goose 因剩余安全和浏览器门槛仍不是公开产品能力。

D3 按“受控只读 Files -> 跨 Run 用量聚合 -> Terminal -> Preview -> Changes”推进，五项均已完成远端验收。D3H 已加入 import boundary、源码/产物凭据扫描、Biome、真实 Workers/D1 migration 测试、Chromium 核心 smoke 和 GitHub Actions 统一门禁。2026-07-30 的非功能加固又加入严格脱敏的 Sentry Error Monitoring、Project owner-scoped 读取门面、统一沙箱回收器、前端双轴活动状态和 tab 键盘导航；没有新增产品领域、D1 表或第二个服务。

## 3. 当前与未来 Runtime 的边界

- `fake`：测试 RunCoordinator、重复启动、失败、取消和 D1 状态收敛；不模拟真实 wall-clock timeout，内存文件也不具备跨请求连续性，因此公共 Files 和 Terminal 不可用。
- `e2b`：开发测试真实 Pi 和 Linux；`E2B_API_KEY` 只在服务端环境中使用。Terminal 通过同源 WebSocket 开放；Preview 通过独立固定 preset、同源签名 GET/HEAD 网关和临时 D1 所有权开放；Changes 只运行固定 Git 读命令。三者都不能直接暴露 E2B URL/ID。当前组合模板以非 root 用户运行并由该用户拥有 `/workspace`，模板探针必须实际完成 Git init/status。
- `cloudflare-container`：以后需要 Cloudflare 原生生产 Runtime 时接入；不要因其名称把业务层绑定到 Containers。
- Pi：默认且已验收的 AgentRuntime，也是当前公开执行路径。
- Goose：按 ADR-0004 实施独立 adapter 和 Pi + Goose 组合模板；远端执行门槛已通过，但 capability 输出脱敏和浏览器选择验收前仍不可出现在 UI 中。
- Claude Code、Codex CLI：仍是后续候选，保留 ID 不表示已支持。

## 4. D2/D3 成本与滥用护栏

以下是当前已有护栏和公开部署前仍需评估的边界：

1. 每个 Project 同时最多一个活动 Provider sandbox、一个非终态 Run 或一个 Terminal 硬锁；当前没有每 User 全局并发额度。
2. 每个 AgentRun 设置最大 wall-clock 时间；真实沙箱接入后记录 `sandbox_duration_ms`。
3. 空闲 TTL 到期后停止沙箱，避免 Project 因打开标签页长期占用资源；停止不做快照。
4. ModelGateway 从 Gemini 实际响应写入 token 和请求数，不把模型成本估算藏在 UI 状态中。
5. 出现 Provider 错误或异常用量时，维护者可用服务端 `RUNS_ENABLED` 总开关暂停新 Run；admin 用量视图和精细配额以后再设计。
6. 早期真实沙箱通过部署邮箱 allowlist 只对自己或受邀测试账号开放；开源不等于开放匿名计算资源。
7. 每个新 AgentRuntime 独立评估镜像体积、冷启动、模型请求路径、凭据持有方式和出网能力，不能沿用 Pi 的成本假设。
8. Cloudflare Workflows Free 当前每 step 10ms CPU、每 instance 最多 50 个外部 subrequest，并包含每天 3,000 steps 与 1GB 状态。Cloudflare 公告 step/storage 计费规则不早于 2026-08-10 生效；Free 超出包含量不会自动产生这两项账单，但会受限。典型 Pi Run 仍需持续观察。
9. Terminal 最长 30 分钟，关闭后复用 10 分钟 idle TTL；不保存 transcript，也不允许关闭浏览器后继续占用交互 PTY。
10. Preview 最长 30 分钟，只能运行固定 Vite preset 和端口；活动时阻止整沙箱回收，停止后复用 10 分钟 idle TTL，不保存页面、日志、截图或访问历史。
11. Changes 不创建沙箱、不延长 Lease、不保存 diff，也不增加外部资源；status/diff 在 Worker 与沙箱两侧都有固定大小边界。
12. Sentry 只接收严格脱敏的错误事件；Tracing、Logs、Replay 和 Metrics 关闭。Sentry 故障不能阻止 Run、API 或 UI，源码映射只在显式 Preview 发布时上传。

截至 2026-07-27，当前 Cloudflare Worker、Static Assets、D1、Workflows 和 Workers Logs 均可使用 Workers Free 额度。E2B Hobby 虽无基础月费，但沙箱计算按秒计费，只有一次性 $100 credits；因此当前系统不是“所有外部算力永久免费”。未来切换 Cloudflare Sandbox/Containers 需要重新核对当时计划和价格，不能沿用本文结论。完整历史口径见 [D2 阶段基线](../status/2026-07-26-d2-baseline.md)。

## 5. 支付不是延后实现项，而是范围外

本仓库不设计：

- 价格和套餐；
- credit / 充值余额；
- 订阅生命周期；
- 支付、退款、发票、税务和 webhook；
- Stripe 或任何支付 Provider。

若未来需要商业化，应从 `AgentRun` 聚合用量重新设计计费领域，而不是把商业对象提前混进 Project、Lease 或权限模型。

## 6. 上线前复核

成本、配额和产品可用性会变化。准备启用真实 Runtime 或公开注册前，复核：

- [Cloudflare Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare Workflows 限制](https://developers.cloudflare.com/workflows/reference/limits/) 与 [定价](https://developers.cloudflare.com/workflows/reference/pricing/)
- [Cloudflare Containers](https://developers.cloudflare.com/containers/)
- [E2B Pricing](https://e2b.dev/pricing) 与 [Billing and limits](https://e2b.dev/docs/billing)
- [Sentry Pricing](https://sentry.io/pricing/)
