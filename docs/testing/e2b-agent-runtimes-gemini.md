# E2B + Pi/Goose + Gemini 真实链路

> 状态：Pi 与 Goose adapter 的组合模板 spike 已通过；Cloudflare Preview 产品路径仍待部署验收。
> 关联：[ADR-0004](../adr/0004-goose-agent-runtime-spike.md) · [运行时边界](../architecture/02-sandbox-runtime.md)

这个 opt-in E2E 测试验证：

```text
本机 ModelGateway
  -> Cloudflare Quick Tunnel
  -> 一个 Pi + Goose 组合 E2B 沙箱
  -> piRuntime 创建文件
  -> gooseRuntime 读取并修改同一文件
  -> piRuntime 再读取并修改
  -> Goose 取消后继续复用同一沙箱
```

测试直接调用仓库中的 `E2BSandboxRuntime`、`piRuntime` 和 `gooseRuntime`，不是在测试里重新拼一套 Agent 命令。

## 安全边界

- `GEMINI_API_KEY` 只留在发起测试的本地进程，由本机 ModelGateway 调用 Gemini。
- E2B 沙箱中没有 `GEMINI_API_KEY` 或 `E2B_API_KEY`。
- 每个 Run 使用正式 `RunCapabilityCodec` 签发彼此不同、绑定 `projectId/runId/modelId` 且五分钟过期的 capability；Pi/Goose provider 配置只保存环境变量名，不保存 token 值。
- 网关只接受 `POST /v1/chat/completions`，绑定固定模型和输出 token 上限，并从真实响应累计 usage。
- 测试结束或失败时会停止 E2B 沙箱、Quick Tunnel 和本机 HTTP server；E2B timeout 仍提供兜底。

短时 capability 会进入对应 Agent 进程环境，这是 Agent 调用 ModelGateway 所需的
运行凭据，不是 Gemini Key。当前测试证明模板、沙箱基线和静态 provider 配置不
持有它；并不声称 Agent 自己或其子工具无法读取该短时凭据。公开产品启用前仍需
完成输出脱敏与工具继承边界复核。

## 组合模板

模板固定：

| 组件 | 版本 |
| --- | --- |
| Node.js | `24.16.0` |
| Pi | `0.82.0` |
| Goose | `1.44.0` |

Goose 从官方 `v1.44.0` Linux x86_64 GNU release 安装，并在构建时校验 SHA-256。模板不包含任何 Key、token 或用户数据。

构建：

```sh
pnpm build:e2b-agent-template
```

当前已验证的精确 build：

```text
agent-online-pi-goose-runtime:130dc6f0-e4d5-4e0f-9682-9142f115b2a8
```

旧 `agent-online-pi-runtime` 模板和构建脚本暂时保留为回滚工具，但新的 Project Runtime 验证必须使用组合模板，不能因切换 Agent 重建沙箱。

## 前置条件

本地 `.dev.vars` 包含：

```sh
GEMINI_API_KEY=...
E2B_API_KEY=...
E2B_TEMPLATE_ID=agent-online-pi-goose-runtime:<build-id>
```

还需要官方 `cloudflared` 可执行文件在 `PATH` 中。若不在 `PATH`，通过 `CLOUDFLARED_BIN` 指定绝对路径。

## 执行

```sh
RUN_E2E=1 pnpm test:e2e:e2b-agent-runtimes
```

或：

```sh
CLOUDFLARED_BIN=/absolute/path/to/cloudflared \
RUN_E2E=1 \
pnpm test:e2e:e2b-agent-runtimes
```

默认 `pnpm test` 会跳过该文件，不创建 E2B 沙箱、Tunnel 或 Gemini 请求。

## 通过条件

1. 组合模板实测版本正确，`/workspace` 可写。
2. 沙箱环境中没有 Gemini/E2B Key，也没有常驻 ModelGateway token。
3. Pi 创建共享文件，Goose 读取并修改，Pi 再读取并修改；全程使用同一 Provider sandbox。
4. 两个 adapter 都解析真实协议并产生成功的 `agent.completed` 与最终文本。
5. ModelGateway 至少观察到三次真实模型请求且总 token 大于零。
6. Goose 通过 shell 创建“已进入长命令”标记后才执行取消；进程被精确终止，随后共享文件和沙箱仍可访问。
7. Pi 和 Goose provider 配置均不包含 capability token 值。
8. 四个 Run 使用四个不同的正式签名 capability，Gateway usage 可按实际 `runId` 区分。

## 2026-07-26 结果

- 组合 E2B template 构建成功，镜像内三项版本探针通过。
- 第一次运行因本机 `cloudflared` 不在 `PATH` 而在创建沙箱前失败；指定已安装二进制后继续。
- 直接 CLI 链路通过后，严格 adapter parser 首次发现 Goose 会输出 session 信息；adapter 增加官方 `--quiet` 参数后，stdout 成为受控 `stream-json`。
- 最终 adapter 级 `Pi -> Goose -> Pi`、每 Run 签名 capability、真实 usage、Key 隔离和可观察的 Goose 取消/沙箱复用全部通过，最近一次耗时约 48 秒。

这仍不等同于 Cloudflare Preview 产品验收。以下项目尚未通过远程 Workflow 验证：

- Hono 创建 Goose Run 后，D1 中真实 `agent_runtime_id = 'goose'`；
- Workflow 跨请求取消、deadline 和失败收敛；
- 组合模板的空闲 TTL 回收；
- 浏览器 Runtime 选择与刷新恢复。

因此 `GOOSE_RUNTIME_MODE` 仍应保持 `disabled` 或测试环境短时使用 `spike`，不能设置为 `public`。
