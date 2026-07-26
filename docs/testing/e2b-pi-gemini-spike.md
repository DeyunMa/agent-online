# E2B + Pi + Gemini 真实链路 Spike

> 状态：D2 可行性验证工具。它不替代 `AgentRunWorkflow`、D1 Run 编排、取消、TTL、文件/终端 API 或正式部署。

这个 opt-in E2E 测试验证一条刻意收窄的真实路径：本机 Worker 兼容的 `ModelGateway` -> Cloudflare Quick Tunnel -> 带预装 Pi 的 E2B 临时沙箱 -> Pi 无 session、无工具调用 -> Gemini 最终回复与实际 usage。

测试使用临时随机 capability token，而不是平台 Gemini Key：

- `GEMINI_API_KEY` 只留在发起测试的本地进程，并由本机网关用于调用 Gemini。
- E2B 沙箱只收到 `AGENT_ONLINE_GATEWAY_TOKEN`。测试在启动 Pi 前断言沙箱中没有 `GEMINI_API_KEY` 或 `E2B_API_KEY`。
- 网关只接受 `POST /v1/chat/completions`，capability 绑定一个固定模型和输出 token 上限。
- 测试结束或失败时，`finally` 会 kill E2B sandbox、关闭 Quick Tunnel 和本机 HTTP server；E2B 还设置 3 分钟自动超时作为兜底。

## 前置条件

本地 `.dev.vars` 必须包含：

```sh
GEMINI_API_KEY=...
E2B_API_KEY=...
E2B_TEMPLATE_ID=agent-online-pi-runtime:<build-id>
```

`E2B_TEMPLATE_ID` 是 E2B 的非敏感部署配置，但仍只应由服务端使用。它必须是精确 build reference，而不是会随时间漂移的 tag；测试会检查模板内的 Node `24.16.0`、Pi `0.82.0` 与可写 `/workspace`。

首次构建或更新模板时运行：

```sh
pnpm build:e2b-pi-template
```

该命令读取本地 `E2B_API_KEY`，在当前 E2B team 下构建 `agent-online-pi-runtime:v1`，然后输出可填入 `.dev.vars` 的精确 `E2B_TEMPLATE_ID`。模板只包含 Node、Pi 与 `/workspace`，不包含 Gemini、E2B 或项目用户密钥。E2B 官方提供 Claude Code、Codex、Amp、OpenCode 等预置 Agent 模板，但没有列出 Pi；因此这里维护一个小而明确的 Pi template，以便锁定依赖版本和密钥边界。

还需要官方 `cloudflared` 可执行文件在 `PATH` 中，例如 macOS 可执行：

```sh
brew install cloudflared
```

若不在 `PATH`，运行时传入它的绝对路径：

```sh
CLOUDFLARED_BIN=/absolute/path/to/cloudflared RUN_E2E=1 pnpm test:e2e:e2b-pi
```

## 执行

```sh
RUN_E2E=1 pnpm test:e2e:e2b-pi
```

通过条件：

1. 临时 E2B sandbox 创建、执行 Pi 并被 kill。
2. Pi 从 custom provider 收到 `AGENT_ONLINE_E2E_OK` 标记。
3. Gateway 收到至少一次真实 Gemini usage，且总 token 大于零。
4. 沙箱不含 `GEMINI_API_KEY` 或 `E2B_API_KEY`。

默认的 `pnpm test` 会跳过该文件，不会创建 E2B sandbox、Quick Tunnel 或 Gemini 请求。

## 结果解释

通过这个 spike 仅证明 E2B、Pi custom provider、Gemini 协议转换和密钥边界能够共同工作。它没有验证 Cloudflare 远程 Workflow、D1 CAS、跨请求取消、空闲 TTL、页面恢复或 Free 计划 CPU 限额。正式执行实现仍以 [ADR-0003](../adr/0003-agent-run-workflow.md) 为准。

测试从项目维护的、精确锁定的 E2B Pi template 创建 sandbox；它不在运行时下载 Node 或安装 Pi。模板的 `Node 24.16.0 + Pi 0.82.0 + /workspace` 合同定义在 [`templates/e2b/pi-runtime.template.mjs`](../../templates/e2b/pi-runtime.template.mjs)，构建脚本在 [`templates/e2b/build-pi-runtime-template.mjs`](../../templates/e2b/build-pi-runtime-template.mjs)。
