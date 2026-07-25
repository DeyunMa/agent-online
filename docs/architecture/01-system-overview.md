# 系统总览：单用户 Project、临时沙箱与可插拔 AgentRuntime

> 状态：架构与工程基线 v0.3
> 关联：[领域术语](../../CONTEXT.md) · [运行时](./02-sandbox-runtime.md) · [数据与模型](./03-data-auth-and-models.md)

## 1. 产品边界

Agent Online 的第一版不是团队协作平台，也不是浏览器内运行 Agent。它是一个浏览器控制台：用户登录后创建 Project；Project 需要执行任务时，控制平面为它创建或复用一个 Linux 沙箱；Agent 在沙箱中操作文件和 shell；浏览器通过 API、SSE、WebSocket 和受控 preview 观察结果。

参考 CCOnline 的是产品体验：真实 Coding Agent、独立 Linux 环境、终端、文件、preview 与可恢复会话。它不代表复制其代码或推断其未公开实现。

当前 Pi 是唯一已注册的 AgentRuntime 和产品默认值。架构允许以后接入 Goose、Claude Code 或 Codex CLI，但它们各自的会话、凭据、许可和事件模型不同，因此必须逐个实现并验收，不能仅靠 Runtime 名称切换。

## 2. 总体结构

```mermaid
flowchart LR
    UI["React 浏览器 UI\nProject、消息、文件、终端、preview"] -->|"same-origin HTTPS / SSE / WS"| W["Cloudflare Worker"]
    W --> H["Hono 控制平面\nAuth / Project / Run / Quota"]
    H --> BA["Better Auth"]
    H --> D1["D1\n用户、Project、Lease、Run、用量"]
    H --> R2["R2\nProject Revision、产物、事件"]
    H --> MG["ModelGateway\nGemini / BYOK"]
    H --> RC["RunCoordinator"]
    RC --> AR["AgentRuntime Adapter\nPi current; others later"]
    RC --> SR["SandboxRuntime Adapter"]
    AR -->|"execute SandboxCommand"| SR
    SR --> SB["Linux Sandbox\nAgent process + shell + Project + preview"]
    SB -->|"opaque CredentialLease"| MG
```

### 浏览器

浏览器只保存 UI 状态和同源认证 Cookie。它能看到：

- Project 和消息；
- 当前 `sandboxLeaseId`、状态、剩余时间和已启用能力；
- 脱敏后的 `AgentEvent`、文件列表、终端流和受控 preview URL。

它不能看到真实供应商 ID、Provider Key、R2 原始对象键、沙箱内部端口或调度密钥。浏览器也不选择任意二进制或直接启动 Agent 进程。

### Cloudflare Worker 控制平面

Hono 负责所有可信操作：认证、Project 授权、用量预留、沙箱启动/停止、R2 Revision、ModelGateway 和事件代理。Worker 只协调 AgentRun，不执行 Agent、用户 shell、构建或依赖安装。

`AgentRuntime` 和 `SandboxRuntime` 是 Worker 代码中的两个模块边界，不是两个部署服务：前者决定如何启动/解释某个 Agent，后者负责对具体沙箱供应商执行通用操作。React 静态资源由同一个 Worker 的 Assets 提供，Hono 处理 `/api/*`；第一版不需要 TanStack Start。

### Linux 沙箱

Agent 进程、shell、Project 文件、终端和用户启动的开发服务都在沙箱中。沙箱是完整执行边界，而不只是一个目录或工具调用后端。当前真实沙箱尚未接入；`FakeSandboxRuntime` 只用于验证模块合同。

## 3. User、Project、SandboxLease 与 AgentRuntime

```text
一个 User      -> 多个 Project
一个 Project   -> 生命周期内多个 SandboxLease
一个 Project   -> 同时最多一个活动 SandboxLease
一个 Lease     -> 只对应一个 Project
一个 Lease     -> 可服务多个连续 Run
一个 Project   -> 一个默认 AgentRuntime
一个 Run       -> 一个已固定的有效 AgentRuntime
```

沙箱不会在每条消息后销毁，也不会永久绑定 Project：

1. 用户创建 Project，初始仅有文件模板和空消息历史。
2. 用户首次创建 Agent Run 或主动启动环境，`RunCoordinator` 创建 `SandboxLease`，恢复最近 Revision，解析 Project 默认 Runtime 或经过授权的覆盖选择。
3. 同一 Project 的后续消息、Run、终端和 preview 复用活动 Lease。
4. 触发空闲 TTL、显式停止、额度耗尽或错误时，控制平面 checkpoint 到 R2 并停止 Lease。
5. 用户重开 Project 时，创建新的 Lease，从 R2 冷恢复。UI 看起来是继续 Project，实际沙箱实例已换新。

## 4. 一次 Agent Run 的流程

```mermaid
sequenceDiagram
    actor User as 用户
    participant UI as React
    participant API as Hono / RunCoordinator
    participant DB as D1 / R2
    participant AR as AgentRuntime
    participant SR as SandboxRuntime
    participant AG as Agent in Sandbox
    participant MG as ModelGateway

    User->>UI: 提交任务
    UI->>API: POST /projects/:id/runs
    API->>API: 校验 User 所有权、QuotaPolicy 和已注册 Runtime
    API->>DB: 创建 UsageReservation 与 Run(agent_runtime_id)
    API->>SR: 查找或创建活动 SandboxLease
    SR->>SR: 必要时恢复最近 WorkspaceRevision
    API->>API: 发放短时 CredentialLease
    API->>AR: start(context, run input)
    AR->>SR: execute(SandboxCommand)
    SR->>AG: 启动 Agent 进程
    AG->>MG: 请求模型流
    MG-->>AG: Gemini / BYOK 流响应
    AG-->>AR: Agent 原始事件和输出
    AR-->>API: 统一 AgentEvent
    API-->>UI: SSE 事件
    API->>DB: 结束 Run，追加 UsageEvent
```

AgentRuntime 不能绕过 Project 授权、用量预留、ModelGateway 或沙箱 Provider。Runtime 的工作是把协议差异收敛到 `AgentEvent`，而不是取得控制平面权限。

## 5. 初始 API 合同

| 路径 | 作用 |
| --- | --- |
| `/api/auth/*` | Better Auth。 |
| `/api/projects` | 创建、列出、读取、删除用户自己的 Project。 |
| `/api/projects/:id/messages` | 读取 Project 消息历史。 |
| `/api/projects/:id/runs` | 创建 Agent Run；必要时启动沙箱，并记录有效 AgentRuntime。 |
| `/api/projects/:id/sandbox` | 查看 Project 活动 Lease 的公开状态。 |
| `/api/projects/:id/sandbox/stop` | 保存并停止活动 Lease。 |
| `/api/sandbox-leases/:id/events` | Agent 状态、工具输出和文件事件的 SSE。 |
| `/api/sandbox-leases/:id/terminal` | 受控终端 WebSocket，后续阶段启用。 |
| `/api/usage` | 当前用户的原始用量、预留和配额状态。 |
| `/api/model-connections` | 默认 Gemini 展示与 BYOK 管理。 |

公共 API 永不接受或返回 `provider_ref`。前端的 `sandboxLeaseId` 是本产品的稳定 ID，E2B/Cloudflare 适配器可以随时替换。`agent_runtime_id` 只可从服务端 registry 和策略白名单中解析，不能直接转换为 shell 命令。

## 6. 非目标

- 不做团队、组织、成员邀请或共享 Project。
- 不做 payment、plan、invoice 或 subscription API。
- 不允许浏览器直接连接供应商终端 URL。
- 不在 Worker 或浏览器中运行 Agent。
- 不在没有适配器、能力声明、凭据设计和 E2E 的前提下公开 Goose、Claude Code 或 Codex CLI。
