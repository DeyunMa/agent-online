# 系统总览：单 Worker、临时沙箱与 AgentRun

> 状态：D2 已通过远程 Preview；D3 受控只读 Files 已完成本地实现，远程验收、用量聚合、Terminal 与 Preview 待完成。
> 关联：[ADR-0002](../adr/0002-run-agent-process-and-lease-lifecycle.md) · [ADR-0003](../adr/0003-agent-run-workflow.md) · [领域术语](../../CONTEXT.md) · [运行时](./02-sandbox-runtime.md) · [数据与模型](./03-data-auth-and-models.md)

## 1. 产品边界

Agent Online 的第一版不是团队协作平台，也不是浏览器内运行 Agent。它是一个浏览器控制台：用户登录后创建 Project；Project 要执行任务时，Worker 为它创建或复用一个 Linux 沙箱；Agent 在沙箱中操作文件和 shell；浏览器通过同源 API、SSE、受控终端和 preview 观察结果。

参考 CCOnline 的是产品体验：真实 Coding Agent、独立 Linux 环境、终端、文件与 preview。它不代表复制第三方代码，或推断其未公开实现。

Pi 是第一版唯一实际注册的 AgentRuntime。架构允许以后接入 Goose、Claude Code 或 Codex CLI，但它们的协议、凭据、许可和事件模型不同，必须逐个实现和验收，不能只靠 Runtime 名称切换。

## 2. 总体结构

```mermaid
flowchart LR
    UI["React 浏览器 UI\nProject、消息、文件、终端、preview"] -->|"same-origin HTTPS / SSE / WS"| W["Cloudflare Worker"]
    W --> H["Hono 控制平面\nAuth / Project / AgentRun"]
    H --> BA["Better Auth"]
    H --> D1["D1\n用户、Project、Message、Lease、AgentRun"]
    H --> MG["ModelGateway\n平台 Gemini Key 和 usage"]
    H --> WF["AgentRunWorkflow\n一个 Run 一个 instance"]
    WF --> RC["RunExecutionService / RunCoordinator"]
    RC --> AR["AgentRuntime\nPi now"]
    RC --> SR["SandboxRuntime\nfake / E2B / later CF"]
    AR -->|"run-scoped process session"| SR
    SR --> SB["Linux Sandbox\nAgent process + shell + Project files"]
    SB -->|"opaque run-scoped model access"| MG
    MG --> GM["Gemini API"]
```

React 静态资源与 Hono API 同域，由同一个 Worker 部署单元提供。`AgentRuntime` 和 `SandboxRuntime` 是 Worker 代码中的模块边界，不是两个后端项目；第一版不需要 TanStack Start 或单独 API 服务。

## 3. 浏览器、平台与沙箱的职责

### 浏览器

浏览器保存 UI 状态和同源认证 Cookie。它能看到：

- Project 与用户可见消息；
- 应用自己的 `sandboxLeaseId`、状态和可用能力；
- 脱敏后的 Agent 状态；现有 E2B Lease 的受控文件列表和 UTF-8 文本；终端流和 preview 只有在对应 API 完成后才可见；
- 自己的基础用量汇总。

它不能看到真实供应商 ID、Provider Key、沙箱内部端口、调度密钥或 Gemini Key，也不能指定任意二进制、Provider 或 shell 命令。

### Worker 控制平面

Hono 负责鉴权、Project 授权、创建和取消 AgentRun、D1 持久化、单 Run 仲裁、沙箱启停编排、事件脱敏、ModelGateway 和基础用量汇总。Worker 只协调 AgentRun，不执行 Agent、用户 shell、构建或依赖安装。

Worker 能拿到对话和用量，是因为它明确拥有请求和事件协议：用户输入先写入 D1，再交给沙箱中的 Agent；Agent 的公开事件和最终回复回到 Worker；模型请求必须经过 Worker 的 ModelGateway。平台不会依赖“抓取沙箱”或读取私有推理。

### Linux 沙箱

Agent 进程、shell、Project 文件、终端和用户启动的开发服务都在沙箱中。沙箱是执行边界，而不只是一个目录。当前 `E2BSandboxRuntime` 已实现真实沙箱、进程和 Lease 级文件合同；`FakeSandboxRuntime` 保留给无外部成本的控制面开发，其内存文件不能跨请求读取，因此公共 Files 会明确返回不可用。

沙箱磁盘是 V1 Project 文件的唯一副本。空闲 TTL、显式停止、Provider 过期或故障后，文件可以丢失；Project 的 D1 元数据和对话仍保留，但新沙箱从空目录开始。

## 4. 资源关系

```text
一个 User      -> 多个 Project
一个 Project   -> 一条逻辑 SandboxLease
一个 Lease     -> 0 或 1 个活动 Provider Sandbox
一个 Project   -> 多个连续 AgentRun
一个 Project   -> 同时最多一个非终态 AgentRun
一个 AgentRun  -> 一个短生命周期 AgentProcess
```

`Project` 没有单独 Session 表，也不包含文件快照。`SandboxLease` 是稳定的应用 ID，Provider 物理实例重建时更新同一行即可。多个连续 Run 可以复用仍存活的沙箱；AgentRun 结束时 AgentProcess 必须终结。

## 5. 一次 AgentRun 的流程

```mermaid
sequenceDiagram
    actor User as 用户
    participant UI as React
    participant API as Hono
    participant DB as D1
    participant WF as AgentRunWorkflow
    participant SR as SandboxRuntime
    participant AG as Pi in Sandbox
    participant MG as ModelGateway
    participant GM as Gemini

    User->>UI: 提交任务
    UI->>API: POST Project AgentRun
    API->>DB: 校验所有权，写用户 Message 与 AgentRun
    API->>WF: 创建 run.id Workflow
    API-->>UI: 返回 queued Run
    WF->>DB: 回读 Message/Run/Lease
    WF->>SR: 取得或创建当前 SandboxLease
    WF->>AG: 用 AgentRuntime 启动受控进程
    AG->>MG: 通过短时不透明通道请求模型
    MG->>GM: 使用 Worker 内 GEMINI_API_KEY
    GM-->>MG: 响应与实际 usage
    MG->>DB: 累加 AgentRun usage
    AG-->>WF: 最终公开回复
    WF->>DB: 写 assistant Message，结束 AgentRun
    UI->>API: 订阅状态 SSE
    API-->>UI: D1 状态与最终 usage
```

浏览器断线不取消 Run。显式取消先将 Run 变为 `cancelling`，再通过 SandboxRuntime 的私有进程引用只终止当前 Pi 进程并写入终态；无法精确终止时才停止整个沙箱。

当前 SSE 在订阅请求内轮询 D1，只发布 `run.status` 和 `run.completed`。它不传递 raw Pi 输出、工具参数或私有推理；终态后页面重新读取可信的 Message 和 usage。执行所有权和恢复规则见 [ADR-0003](../adr/0003-agent-run-workflow.md)。

## 6. API 状态

当前已实现以下同源 API：

| 路径 | 作用 |
| --- | --- |
| `/api/auth/*` | Better Auth。 |
| `/api/projects` 与 `/api/projects/:id` | 创建、列出、读取用户自己的 Project。 |
| `/api/projects/:id/messages` | 读取 Project 的可见消息。 |
| `/api/projects/:id/files` | 在没有活动 Run 时列出现有沙箱 `/workspace` 下的受控目录。 |
| `/api/projects/:id/files/content` | 读取受限相对路径指向的 UTF-8 文本文件。 |
| `/api/projects/:id/agent-runs` | 创建 AgentRun，或读取当前用户该 Project 最近 50 条 Run 事实。 |
| `/api/projects/:id/agent-runs/active` | 读取该 Project 当前的非终态 Run，供页面恢复。 |
| `/api/projects/:id/agent-runs/:runId` | 读取 Run 状态和已聚合用量。 |
| `/api/projects/:id/agent-runs/:runId/events` | 订阅 D1 轮询出的状态和终态，不公开 raw Agent 输出。 |
| `/api/projects/:id/agent-runs/:runId/cancel` | 取消当前 Run。 |
| `/api/projects/:id/sandbox/stop` | 在没有非终态 Run 时原子脱离并停止当前沙箱；不公开 Provider ID。 |

以下 API 留待后续 Runtime 或管理能力阶段实现：

| 路径 | 作用 |
| --- | --- |
| `/api/projects/:id/sandbox` | 查看应用级 Lease 的公开状态。 |
| `/api/usage` | 当前用户的 AgentRun 聚合用量。 |
| `/api/admin/usage` | 仅 `ADMIN_EMAILS` allowlist 使用的基础汇总。 |

所有 API 都以应用级资源 ID 工作。公共 API 不接受或返回 `provider_ref`；`agent_runtime_id` 只能由服务端 registry 和策略白名单解析，不能直接转换为 shell 命令。

## 7. 非目标

- R2 Project 文件快照、文件版本、回滚、沙箱历史和完整原始执行归档。
- 团队、组织、成员邀请、Tenant、支付、套餐或订阅 API。
- 浏览器直接连接供应商终端 URL 或模型 API。
- 在 Worker 或浏览器中运行 Agent。
- 在没有适配器、能力声明、凭据设计和 E2E 前公开 Goose、Claude Code 或 Codex CLI。
