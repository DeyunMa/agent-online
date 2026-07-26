# 2026-07-26 D4 Goose Runtime Spike

> 结论：第二个 `AgentRuntime` 的代码、组合模板和本地真实 E2E 已成立；产品公开门槛尚未全部通过，Goose 继续保持门控。

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

## 5. 尚未通过的产品门槛

- Cloudflare Preview 中由 Hono 创建真实 Goose Run，并确认 D1、最终 assistant Message 和 usage。
- Workflow 跨请求取消、deadline、失败恢复与组合模板空闲 TTL。
- Preview API/日志脱敏复核。
- 短时 capability 在 Agent 进程及其工具中的继承边界与输出脱敏复核。
- 浏览器 Runtime 选择、刷新恢复和移动端验收。

因此当前：

- Project 默认 Runtime 仍是 Pi；
- `GOOSE_RUNTIME_MODE` 默认 `disabled`；
- UI 仍显示不可操作的 Pi 控件；
- 不能对外声称 Goose 已是可用产品功能。

`GOOSE_RUNTIME_MODE=spike` 只是执行/能力发布门控，不是额外的用户权限。
任何通过现有认证和部署访问策略的用户都可手工请求已启用的 Goose；因此该模式
只能用于当前邮箱 allowlist 保护的私有 Preview。

## 6. 下一步

1. 在明确授权的 Preview 部署中，将组合模板与 `GOOSE_RUNTIME_MODE=spike` 一起上线。
2. 使用新 Project（或先停止旧 Pi-only sandbox），通过 API 完成真实 Goose Run、取消、deadline 和 TTL 验收。
3. 全部通过后把模式提升为 `public`，再启用 React Runtime 选择。
4. Goose 收敛后回到用量聚合、Terminal 和 Preview 纵切。
