# ADR-0005：以同源 WebSocket 提供受控 Project Terminal

- 状态：Accepted；实现、迁移、部署与远程验收已完成
- 日期：2026-07-26
- 关联：[ADR-0002](./0002-run-agent-process-and-lease-lifecycle.md) · [ADR-0003](./0003-agent-run-workflow.md) · [运行时边界](../architecture/02-sandbox-runtime.md)

## 背景

Agent Online 需要让登录用户在浏览器中操作当前 Project 的真实 Linux 终端。终端必须复用 Project 唯一当前沙箱和 `/workspace`，但不能把 E2B sandbox ID、PTY PID、内部端口或 Provider Key 交给浏览器。

终端不是 AgentRuntime，也不是新的 durable Agent Session。它是 Project 级临时交互能力：打开时独占当前沙箱，关闭后不保留滚屏、命令历史或审计副本。

## 决策

### 1. Terminal 是独立 Runtime capability

`SandboxTerminalRuntime` 与 lifecycle、process、filesystem capability 分离。E2B adapter 使用官方 PTY API 实现：

- 固定工作目录 `/workspace`；
- 受限的初始行列、输入块和 resize；
- 二进制 PTY 输出；
- 明确的关闭、超时和按私有 PID 终止；
- 最长 30 分钟会话。

`FakeSandboxRuntime` 不模拟持久 PTY，也不公开 Terminal capability。`AgentRuntime` 继续只负责 Pi/Goose 协议，不混入终端生命周期。

### 2. 浏览器只连接同源 Worker WebSocket

公共路径为：

```text
GET /api/projects/:projectId/terminal
Upgrade: websocket
Origin: same origin
```

Worker 在升级前校验 Better Auth Session、同源 `Origin` 和 Project 所有权。升级后浏览器发送规范化的 `attach`、`input`、`resize`、`close` 消息；Worker 返回 `ready`、二进制 PTY output、`closed` 或通用错误码。

浏览器协议不包含 Provider sandbox ID、PTY PID、内部 URL、端口、模型凭据或任意 Runtime 参数。Hono 路由只调用 `ProjectTerminalService`，不根据输入拼接 shell 命令。

### 3. 一个 Project 同时最多一个活动 Terminal

D1 新增 `terminal_sessions`，每个 Project 最多一行。该表只保存当前临时占用：

```text
id
project_id
sandbox_lease_id
provider_sandbox_ref
provider_process_ref
expires_at
created_at
updated_at
```

它不保存输入、输出、shell history、终端标题或文件内容。会话关闭后删除该行。

Terminal claim 在 D1 中同时检查 Lease 的 `updated_at/provider_ref` 快照、活动 AgentRun 和任意已有 Terminal 行。反向触发器拒绝在 Terminal 行存在时插入 AgentRun。Files、手动停止和 idle cleanup 也检查该占用。`expires_at` 只供 durable expiry Workflow 调度，不能按墙钟自动放开互斥。由此形成：

```text
同一 Project：AgentRun XOR Terminal
```

这是当前个人项目所需的互斥，不扩展为多终端、协作终端或终端历史。

### 4. 关闭后复用现有 idle TTL

每次 claim 成功后，Worker 必须先创建 `terminal-expiry-<sessionId>` Workflow，成功后才能取得或创建沙箱和 PTY。Workflow 在 `expires_at` 主动终止记录中同一 Provider sandbox 的私有 PTY；Worker 内存 timer 只是低延迟补充，不承担持久回收。

PTY 自然退出、浏览器断开或用户关闭时，Worker 先确认 PTY 已终止，再以一个 D1 batch 删除 `terminal_sessions` 并将同一 Provider Lease 标为 `idle`。如果 PTY kill 失败，则停止整个记录所属的 Provider sandbox 后再原子删除锁并把 Lease 标为 `stopped`；两者都无法确认时，只把 Lease 标为 `failed` 并保留 Terminal 行，不能让新 Run 进入未知状态的沙箱。

释放成功后创建 `terminal-idle-<sessionId>` Workflow。它等待现有 `RUNTIME_IDLE_TTL_SECONDS`，再按释放时的 `sandbox_leases.updated_at` 原子认领并停止沙箱。期间只要有新 AgentRun、Terminal 或 Lease 更新，旧 Workflow 就不会误停当前环境。Workflow 创建失败时，E2B 自身 timeout 是最终回收边界。

### 5. 前端使用真实 xterm

右栏 `Project inspector` 启用 Terminal tab，并按需加载 `@xterm/xterm` 与 `@xterm/addon-fit`。用户显式点击 Connect 才创建远程 PTY；切换 inspector tab 不会卸载活动终端，切换 Project 或离开页面会关闭连接。

连接或活动期间，前端禁用 New Run、Composer、Files 和 Stop sandbox；后端 D1 互斥仍是可信边界。界面只显示真实状态和真实 PTY 字节，不生成示例命令或伪造输出。

## 安全与限制

- WebSocket 必须使用认证 Cookie 和精确同源 `Origin`。
- 单条 input 最大 16 KiB；行列限制为 20–240 列、5–100 行。
- WebSocket 必须在 10 秒内发送 `attach`；原始 frame 有字节上限，串行消息队列最多 32 条。
- E2B `onData` 采用 256 KiB 有界待消费队列；单会话 PTY 输出累计达到 8 MiB 时终止会话，避免无界 Worker 内存和 WebSocket 缓冲。
- Terminal 最长 30 分钟，不提供 detach/reconnect 或后台常驻 shell。
- 终端内用户可以在低信任沙箱中执行任意开发命令，但不能访问 Worker Secret、D1 Binding 或 Provider 管理凭据。
- D1 不记录终端用量或历史；现有 Usage 页仍只聚合 AgentRun。E2B sandbox timeout 与 idle TTL 控制终端资源成本。
- 标准 Worker WebSocket 会在连接期间保持 Worker 与 E2B PTY 流；本阶段不引入 Durable Object。

## 未采用方案

| 方案 | 不采用原因 |
| --- | --- |
| 浏览器直连 E2B | 会泄露 Provider 地址、标识和控制能力。 |
| 每个终端创建独立沙箱 | 破坏 Project `/workspace` 连续性并增加成本。 |
| 使用通用 `startProcess` 模拟终端 | 缺少 PTY resize、控制字符和明确会话关闭语义。 |
| 保存完整终端 transcript | 超出个人项目边界，并增加敏感内容与审计负担。 |
| 多终端或可恢复终端 Session | 需要更重的并发、所有权和历史模型。 |

## 验收

远程 Preview 发布前后应验证：

1. 登录用户只能打开自己的 Project Terminal，跨域握手被拒绝。
2. `pwd` 为 `/workspace`，创建文件后 Files 与后续 AgentRun 能看到同一文件。
3. Terminal 活动时，新 AgentRun、Files 和手动停止返回或显示 `project_busy`。
4. 输入、resize、自然退出、显式关闭和浏览器断线都能释放 D1 临时占用；无法确认 PTY/sandbox 终止时必须保留锁。
5. 关闭后沙箱为 `idle`，TTL Workflow 可停止未被再次使用的沙箱。
6. 浏览器响应、WebSocket、D1 公共查询和日志不出现 Provider sandbox ID、PTY PID 或 Key。
7. 桌面和移动 viewport 中 terminal 不溢出、遮挡或改变三栏/折叠布局。

## 后果

Terminal 增加一个临时 D1 表、一项 Runtime capability、一条同源 WebSocket 路径，以及 expiry/idle cleanup 两种 Workflow payload，但不增加外部服务、环境变量、R2、第二个 Worker 或长期数据。后续 Preview 已按 [ADR-0006](./0006-controlled-project-preview.md) 复用相同授权与 Lease 边界，并独立处理固定进程、同源内容代理和生命周期。
