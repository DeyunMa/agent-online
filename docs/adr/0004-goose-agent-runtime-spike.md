# ADR-0004：以组合模板受控验证 Goose AgentRuntime

- 状态：Accepted；已批准在受 allowlist 保护的产品 UI 中启用
- 日期：2026-07-26
- 关联：[ADR-0002](./0002-run-agent-process-and-lease-lifecycle.md) · [ADR-0003](./0003-agent-run-workflow.md) · [运行时边界](../architecture/02-sandbox-runtime.md)

## 背景

Pi 已完成 E2B、Gemini ModelGateway、最终 Message、usage、取消、deadline 和空闲回收的真实验收。项目希望验证已设计的 `AgentRuntime` 边界是否真的允许接入第二个 Coding Agent，而不是只保留一个没有经过实践的接口。

本次选择 Goose 做第二个 Runtime spike。它必须复用现有 `Project -> AgentRun -> SandboxLease` 产品模型，并证明同一 Project 能在不同 Agent 之间切换而不丢失当前沙箱中的 `/workspace`。

这不是把任意 CLI 暴露给浏览器。Pi 仍是默认 Runtime；Goose 在所有验收项通过前只存在于服务端 feature flag 后，通过后也只能作为服务端能力接口公布的受控选项。

## 决策

### 1. Goose 是独立 AgentRuntime adapter

新增 `GooseAgentRuntime`，它只负责：

- 生成 Goose 自己的受控配置、固定命令和每 Run 临时目录；
- 启动 Goose 进程；
- 把 Goose 的公开 JSONL 输出归一化为现有 `AgentEvent`；
- 提取最终用户可见文本；
- 通过通用进程会话完成取消。

Hono、Workflow 和 `RunCoordinator` 不根据 Runtime ID 拼接任意 shell 命令。Runtime ID 只能在显式 registry/allowlist 中解析为已安装 adapter。

Goose 与 Pi 共用现有 Message、AgentRun、SandboxLease、ModelGateway、usage、取消、deadline 和空闲回收生命周期。项目不新增 Goose Session 表、原始 transcript、第二套 usage 或第二个后端服务。

### 2. 使用一个 Pi + Goose 组合 E2B 模板

同一 Project 当前文件只存在于唯一当前沙箱。若 Pi 和 Goose 使用互斥模板，切换 Runtime 就必须重建供应商沙箱并丢失 `/workspace`，这不符合产品目标。

因此 E2B 使用一个组合模板，初始 spike 固定：

- Node.js `24.16.0`
- Pi `0.82.0`
- Goose `1.44.0`

模板只预装二进制和创建可写 `/workspace`，不写入 Gemini Key、ModelGateway token、E2B Key、用户数据或 Provider 引用。版本升级必须重新构建精确 template build 并重新执行两种 Runtime 的真实 E2E。

一个 Project 仍只有一个逻辑 `SandboxLease` 和最多一个活动供应商沙箱。Runtime 选择属于每个 `AgentRun`，不改变 Lease 归属，也不建立 Runtime 专属沙箱历史。

### 3. Goose 只能通过 Worker ModelGateway 访问模型

Goose 使用声明式 OpenAI-compatible provider，配置写入每个 Run 独立的 `GOOSE_PATH_ROOT`：

```text
/tmp/agent-online-goose/<agentRunId>/
  config/custom_providers/agent_online.json
  prompt.md
```

provider 指向 Worker 的受控 chat-completions endpoint，并从专用环境变量读取该 Run 的短时 bearer capability。短时 capability 仍绑定 `projectId`、`runId`、`modelId`、scope 和过期时间。

沙箱和模板永远不获得 `GEMINI_API_KEY`、`BETTER_AUTH_SECRET` 或 E2B 管理凭据。Goose 输出中的 usage 不写入 D1；D1 usage 继续以 ModelGateway 观察到的真实请求为唯一计量来源，避免重复累计。

若 Goose 的 OpenAI-compatible 请求与现有 ModelGateway 不兼容，应显式扩展并测试网关合同，或判定 spike 阻塞。不得以向沙箱注入原始 Gemini Key 作为临时绕过。

### 4. 固定非交互命令与能力声明

首个 adapter 使用固定的 headless 命令形态：

```text
goose run
  --no-session
  --no-profile
  --with-builtin developer
  --max-turns <bounded>
  --provider agent_online
  --model <server-selected-model>
  --quiet
  --output-format stream-json
  --instructions <run-private-prompt-file>
```

环境固定为 `GOOSE_MODE=auto`，并关闭不必要的 session 命名。adapter 不开放用户自定义 provider、扩展、命令参数、环境变量、TTY 或宿主路径。

Goose 初始能力按真实 adapter 声明：

| 能力 | 初始值 | 说明 |
| --- | --- | --- |
| ModelGateway | 是 | 只允许短时 capability。 |
| 精确进程终止 | 是 | 复用 `SandboxProcessSession.terminate()`。 |
| stdin | 否 | 一次性 headless Run，不建立交互 Session。 |
| 流式输出 | 是 | 只消费受控 `stream-json`；不保存 raw transcript。 |
| TTY | 否 | 不向浏览器暴露 Goose TUI。 |

### 5. 产品选择由服务端能力决定

服务端维护启用 Runtime 的显式 allowlist，默认只有 `pi`。创建 Run 时：

1. 校验 Runtime 已安装且被环境配置启用；
2. 校验当前 SandboxRuntime 满足该 AgentRuntime 的能力；
3. 把实际 Runtime 写入 `AgentRun.agent_runtime_id`；
4. Workflow 从 D1 读取该值并解析 adapter，不信任浏览器命令或 Provider 参数。

前端只展示服务端公开能力接口返回的已验收 Runtime。Goose spike 未通过时不显示可选择项，也不能用静态假数据伪装为可用。

## 验收门槛

Goose 只有全部通过后才能加入 UI：

1. 同一 Project 先由 Pi 创建文件，再由 Goose 读取并修改，再切回 Pi 验证修改仍在。
2. Goose 最终回复写成唯一 assistant Message，且 `AgentRun.agent_runtime_id = 'goose'`。
3. D1 usage 来自 ModelGateway 的真实请求，不因 Goose 自带 metadata 重复累计。
4. 取消只终止当前 Goose 进程；沙箱仍可被下一 Run 复用。
5. deadline、失败和 Workflow 重试能收敛到明确终态。
6. 空闲 TTL 能停止组合模板沙箱并清除私有 Provider 引用。
7. 浏览器响应、SSE、日志和 D1 不含 E2B sandbox ID、进程引用、内部端口、原始模型 Key或完整短时 token。
8. Pi 的既有 E2E 在组合模板上继续通过。

任一关键项失败时，Goose 保持 feature flag 关闭。组合模板可以继续包含未启用的 Goose 二进制，但产品不得声称支持它。

## 代价与风险

- 组合模板镜像更大，冷启动和 E2B 存储/构建时间需要重新测量。
- Goose 的 CLI JSON schema、provider 配置和 headless 行为可能随版本变化，因此必须固定版本并为 parser 建立契约测试。
- `GOOSE_MODE=auto` 允许 Agent 在低信任沙箱内执行开发工具；它不提升到 Worker、D1 或 Provider 控制面。
- Run capability 是 Agent 调用 ModelGateway 所需的短时、限 Run 凭据，因此会存在于 Agent 进程环境，且 Agent 工具可能继承它。它不是原始 Gemini Key；公开启用前仍要复核工具继承、精确 token 输出脱敏和过期后的失效行为。
- Pi 与 Goose 对 prompt、工具和最终文本的事件粒度不同，统一事件只承诺产品需要的最小交集。
- 本 ADR 不批准 Claude Code、Codex CLI、任意 MCP 扩展、BYOK 或公开任意命令执行。

## 回滚

关闭 Goose allowlist 并从 registry 的可用集合移除即可恢复 Pi-only 产品行为，不需要迁移 D1。已写入历史 `AgentRun.agent_runtime_id = 'goose'` 的记录仍可只读展示；个人开发阶段也允许清理本地/Preview 测试数据。

## 当前实施结果

截至 2026-07-26，Goose adapter、`GOOSE_RUNTIME_MODE` 服务端门控、Pi + Goose
组合模板和 adapter 级真实 E2E 已完成。真实测试证明同一 E2B sandbox 中
Pi 创建文件、Goose 修改、Pi 再验证，以及 Goose 精确取消后沙箱继续复用；
两种 Runtime 都只通过短时 ModelGateway capability 调用 Gemini，provider
配置不含 token 值。

Cloudflare Preview 已使用组合模板和 `GOOSE_RUNTIME_MODE=spike` 完成真实
`Pi -> Goose -> Pi`、D1 最终事实、usage、取消、deadline、恢复和空闲 TTL
验收；手动停止与 Files 停止状态也通过。公开 capabilities 仍只返回 Pi。
随后受控 Changes 使用保留相同 Node/Pi/Goose 版本、并显式加入 Git/Bash/coreutils
探针的组合模板。2026-07-30 的第三版又保证 E2B 默认用户拥有 `/workspace`，并在
模板探针中实际完成 Git init/status；`Pi -> Goose -> Pi -> Goose cancel` 真实 E2E
再次通过。Runtime 切换仍不重建当前沙箱。

因此本 ADR 的“实现 spike”和“私有 Preview 执行验证”均成立。2026-07-30
进一步完成了能力接口驱动的 React Runtime 选择、每次创建 Run 显式提交
`agentRuntimeId`、移动端浏览器回归，以及最终 assistant Message 对当前 Run
capability 的精确脱敏。选择偏好有意不持久化：刷新后恢复平台默认 Pi，已经创建的
Run 仍以 D1 中的 `agent_runtime_id` 为准。

短时 capability 仍会进入对应 Agent 主进程环境，子工具可继承它；这是当前
ModelGateway 接入方式的已知限制。它绑定单个 Project/Run/模型和 deadline，且 Run
进入终态后网关立即拒绝；平台不把它写入配置、日志或最终 Message。本项目接受这一
受限残余风险，不把它等同于原始 Gemini Key。

普通环境默认模式继续是 `disabled`。私有 Preview 的仓库部署目标改为 `public`，
表示安全的 capabilities 响应公布 Pi/Goose，已通过登录和邮箱 allowlist 的用户可在
UI 中选择；这不改变私有注册边界，也不批准任意第三方 Runtime。

## 参考

- [Goose repository](https://github.com/aaif-goose/goose)
- [Goose providers](https://github.com/aaif-goose/goose/blob/main/documentation/docs/getting-started/providers.md)
- [Goose CLI commands](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/goose-cli-commands.md)
- [Goose environment variables](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/environment-variables.md)
