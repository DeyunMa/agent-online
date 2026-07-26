# 2026-07-26 D4 Goose Runtime Spike

> 结论：第二个 `AgentRuntime` 的代码、组合模板、本地 E2E 和私有 Cloudflare Preview 产品链路均已成立；Goose 继续保持 `spike` 门控，不向浏览器公开。

## 1. 本阶段完成

- 新增独立 `gooseRuntime`，不在 Hono 或 SandboxRuntime 中拼 Goose 命令。
- Goose 使用固定 headless `stream-json` 协议、每 Run `GOOSE_PATH_ROOT`、无 session、无 profile 和受控 `developer` builtin。
- 新增单变量门控 `GOOSE_RUNTIME_MODE=disabled|spike|public`：
  - `disabled`：默认，只执行并公布 Pi；
  - `spike`：E2B 可显式创建 Goose Run，但能力接口仍只公布 Pi；
  - `public`：通过剩余验收后才允许公布 Pi/Goose。
- 创建 Run API 接受可选 `agentRuntimeId`，先经过服务端 allowlist，再写入 D1；未启用 Runtime 在写 Message、Lease、Run 前返回明确错误。
- Worker 执行路径再次按环境策略解析 Runtime；手工写入未启用 Runtime 的 D1 Run 也不能绕过门控。
- `/api/capabilities` 只返回公开 Runtime ID、默认 Runtime 与 Run 总开关，不泄露 gate mode 或供应商信息。

## 2. 组合模板

精确 build：

```text
agent-online-pi-goose-runtime:130dc6f0-e4d5-4e0f-9682-9142f115b2a8
```

构建内实测：

| 组件 | 版本 |
| --- | --- |
| Node.js | `24.16.0` |
| Pi | `0.82.0` |
| Goose | `1.44.0` |

Goose 官方归档在安装前验证 SHA-256；模板没有模型 Key、Provider Key、capability 或用户数据。旧 Pi-only 模板保留为回滚工具。

模板只影响新建的 Provider sandbox。已经存活的 Pi-only sandbox 不会原地升级；
Preview 验收应使用新 Project，或先停止旧 Project sandbox、清除其当前 Provider
引用后再执行 Goose。个人 Preview 阶段不为这次模板切换增加版本表或兼容迁移。

## 3. 真实 E2E 证据

测试直接使用仓库里的 `E2BSandboxRuntime`、`piRuntime` 和 `gooseRuntime`：

1. 同一沙箱内由 Pi 创建共享文件。
2. Goose 读取 Pi 文件并追加第二行。
3. Pi 读取 Goose 修改并追加第三行。
4. 两种 Runtime 均经本机 ModelGateway 和每 Run 独立的正式签名 capability 调用真实 Gemini。
5. Gateway 观察到至少三次请求和非零 token，并能按真实 Run ID 区分 usage。
6. Goose 进入可观察的长 shell 命令后被精确取消，沙箱与共享文件仍可访问。
7. 沙箱没有 `GEMINI_API_KEY` 或 `E2B_API_KEY`；两种 provider 配置不包含 capability token 值。

加强后的 adapter 级 E2E 通过，最近一次耗时约 48 秒。

调试中发现 Goose 即使使用 `stream-json` 也会默认向 stdout 输出 session 信息。严格 parser 正确拒绝了该输出；adapter 增加官方 `--quiet` 后，真实 JSONL 合同通过。没有通过忽略任意非 JSON 文本来绕过。

## 4. 自动验证

- Goose adapter、registry、门控、capabilities 和 Run API 相关测试通过。
- D1 repository 测试覆盖 `agent_runtime_id = 'goose'` 的写入与映射。
- 类型检查通过。
- 完整 test/build 结果在本阶段提交前重新执行。

## 5. Cloudflare Preview 验收

私有 Preview 使用组合模板和 `GOOSE_RUNTIME_MODE=spike` 完成：

| 场景 | 结果 |
| --- | --- |
| Pi 创建文件 -> Goose 读取并修改 -> Pi 再验证 | 三次 Run 成功，复用同一逻辑 Lease 和同一活动沙箱。 |
| D1 与最终输出 | `agent_runtime_id`、最终 assistant Message、模型请求数、token 和沙箱时长均正确。 |
| Goose 取消 | 进入长 shell 后收敛为 `cancelled`，无 assistant Message，沙箱可继续复用。 |
| Goose deadline | 临时 8 秒 wall clock 下收敛为 `timed_out`；恢复 1800 秒后 12 秒任务成功。 |
| 组合模板 TTL | 临时 8 秒 TTL 的 Workflow 返回 `detached=true, stopped=true`，Lease 清空 Provider 引用；正式值恢复为 600 秒。 |
| Files 与手动 Stop | 真实目录/文本可见；手动停止后 Lease 为 `stopped`、Provider 引用为空，Files 不显示陈旧缓存。 |
| 公开能力与脱敏 | `/api/capabilities` 仍只公布 Pi；浏览器响应不含 Provider 标识，D1 Message 未发现 Key 或 capability 名称。 |

最终部署 Worker 版本为 `d424d9ed-4a4f-45ea-aa89-2856cc78885a`。验收期间的临时 deadline/TTL 配置均已恢复，当前为 1800 秒和 600 秒。

首次 TTL 探针紧邻部署启动，命中了仍在传播的旧 Workflow 版本；等待最新 Workflow 版本生效后重新执行，8 秒 sleep 与停止步骤均通过。涉及 timeout/TTL 的后续部署必须先确认 Workflow 版本传播完成。

## 6. 尚未通过的公开门槛

- 短时 capability 在 Agent 进程及其工具中的继承边界与精确输出脱敏复核。
- Goose 公开响应和 Workers Logs 的针对性泄漏测试需要固化为可重复门禁；本次 D1/API 抽查通过，但不替代长期日志策略。
- 浏览器 Runtime 选择、刷新恢复和移动端验收。

因此当前：

- Project 默认 Runtime 仍是 Pi；
- 仓库默认环境仍为 `disabled`，私有 Preview 当前为 `spike`；
- UI 仍显示不可操作的 Pi 控件；
- 不能对外声称 Goose 已是可用产品功能。

`GOOSE_RUNTIME_MODE=spike` 只是执行/能力发布门控，不是额外的用户权限。
任何通过现有认证和部署访问策略的用户都可手工请求已启用的 Goose；因此该模式
只能用于当前邮箱 allowlist 保护的私有 Preview。

## 7. 下一步

1. 保持私有 Preview 为 `spike`，先固化 capability 工具继承和输出/日志脱敏门禁。
2. 公开门槛全部通过后再实现 React Runtime 选择，并完成刷新与移动端验收。
3. 产品主线的跨 Run Usage、use-case/route 加固和受控 Terminal 已完成本地实现；下一步是 Terminal 远端验收与受控 Preview。
