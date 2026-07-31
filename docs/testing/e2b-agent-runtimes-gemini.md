# E2B + Pi/Goose + Gemini 真实链路

> 状态：Pi 与 Goose adapter 的组合模板本地 E2E 和 Cloudflare Preview 受控产品链路均已通过；能力驱动的浏览器 Runtime 选择与最终回复精确脱敏已完成本地验收，部署后仍需执行 Hosted E2E。
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
持有它；Agent 自己或其子工具仍可能读取该短时凭据。平台在最终 Message 入库前对
本次 capability 做精确脱敏，且网关在 Run 终态后立即拒绝它。

## 组合模板

模板固定：

| 组件 | 版本 |
| --- | --- |
| Node.js | `24.16.0` |
| npm | `11.13.0` |
| pnpm | `10.33.2` |
| 平台 Vite | `8.1.5` |
| Python / pip | `3.11.2` / `23.0.1` |
| Pi | `0.82.0` |
| Goose | `1.44.0` |
| Git | `2.39.5` |
| Bash | `5.2.15` |
| ripgrep / jq | `13.0.0` / `1.6` |

Goose 从官方 `v1.44.0` Linux x86_64 GNU release 安装，并在构建时校验 SHA-256。v4
模板显式安装常用 shell、归档、Git、搜索、JSON、Python 和原生编译工具，并在只读
`/opt/agent-online/preview` 固定平台 Vite。模板不包含任何 Key、token 或用户数据；
E2B 默认非 root 用户拥有唯一可写的 `/workspace`，避免 Terminal/Agent 创建的
repository 因目录所有权不一致触发 Git `safe.directory` 拒绝。

构建：

```sh
pnpm build:e2b-agent-template
```

当前已验证的精确 build：

```text
agent-online-pi-goose-runtime:06295331-78c7-46db-ab18-d763a51bae6c
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

1. 组合模板实测 Node/npm/pnpm、Pi/Goose、Python/pip、Git/Bash、rg/jq、编译器和平台 Vite 版本正确；只读 manifest 与平台目录不可被运行用户修改，`/workspace` 由默认用户拥有且可写，并能完成 Git init/status。
2. 沙箱环境中没有 Gemini/E2B Key，也没有常驻 ModelGateway token。
3. Pi 创建共享文件，Goose 读取并修改，Pi 再读取并修改；全程使用同一 Provider sandbox。
4. 两个 adapter 都解析真实协议并产生成功的 `agent.completed` 与最终文本。
5. ModelGateway 至少观察到三次真实模型请求且总 token 大于零。
6. Goose 通过 shell 创建“已进入长命令”标记后才执行取消；进程被精确终止，随后共享文件和沙箱仍可访问。
7. Pi 和 Goose provider 配置均不包含 capability token 值。
8. 四个 Run 使用四个不同的正式签名 capability，Gateway usage 可按实际 `runId` 区分。
9. 空工作区被 Preview 预检识别为 `entry_missing`；创建静态 `index.html` 后由平台固定
   Vite 启动，并通过固定 base path 读取真实 marker，随后进程可精确停止。

## 2026-07-26 结果

- 第二版组合 E2B template 构建成功，镜像内 Node/Pi/Goose/Git/Bash 版本探针通过。
- 第一次运行因本机 `cloudflared` 不在 `PATH` 而在创建沙箱前失败；通过 Homebrew 安装官方二进制后重新执行。
- 直接 CLI 链路通过后，严格 adapter parser 首次发现 Goose 会输出 session 信息；adapter 增加官方 `--quiet` 参数后，stdout 成为受控 `stream-json`。
- 最终 adapter 级 `Pi -> Goose -> Pi`、每 Run 签名 capability、真实 usage、Key 隔离和可观察的 Goose 取消/沙箱复用全部通过；第二版模板最近一次完整 E2E 耗时约 47 秒。

## Cloudflare Preview 结果

私有 Preview 使用精确组合模板和 `GOOSE_RUNTIME_MODE=spike`，通过同源 Hono API 与 Cloudflare Workflow 验证：

1. Pi 创建文件、Goose 修改、Pi 再验证，同一 Project 的当前沙箱文件连续。
2. Goose 最终回复、`agent_runtime_id='goose'` 和真实 usage 正确写入 D1。
3. Goose 长 shell 可跨请求取消；Run 为 `cancelled`、无 assistant Message，Lease 回到 idle。
4. 临时 8 秒 deadline 下 Run 为 `timed_out`；恢复 1800 秒后超过 8 秒的任务成功。
5. 临时 8 秒空闲 TTL 下 Workflow 原子脱离并停止沙箱；恢复后的正式 TTL 为 600 秒。
6. 浏览器真实验证 Files、停止状态和手动 Stop；停止后不请求 Files，也不显示陈旧缓存。
7. `/api/capabilities` 在 spike 模式只返回 Pi；未登录业务 API 为 `401`。
8. D1 抽查未发现原始 Key/capability 名称，终态 Run 不保留进程引用，停止 Lease 不保留 Provider 引用。

配置部署后，Worker 与 Workflow 版本存在短暂传播窗口。第一次 TTL 探针命中旧 Workflow 版本，因此正式 timeout/TTL 验收必须先在 Workflow 详情确认最新版本，再运行探针。

2026-07-30 已批准在邮箱 allowlist 保护的 Preview 中设置
`GOOSE_RUNTIME_MODE=public`。React 选择器只消费 `/api/capabilities`，创建 Run
显式发送选择值；本地浏览器回归覆盖选择与请求合同。选择偏好不持久化，刷新后恢复
默认 Pi；既有 Run 的实际 Runtime 仍从 D1 恢复。Hosted UI 的 Pi/Goose 切换需要在
包含本次代码的部署后再次验收。

## 2026-07-30 模板权限修复结果

- 首次尝试只指定 `makeDir(..., user: "user")`，因非 root 用户不能在 `/` 下创建
  `/workspace` 而在构建阶段失败；该构建未发布。
- 第三版改为 root 创建和 `chown`，再显式切换到 E2B 默认用户；模板探针验证
  `/workspace` 所有权、写入、Git init/status 和密钥缺失。
- 真实 adapter E2E 在同一个第三版沙箱完成 `Pi -> Goose -> Pi -> Goose cancel`，
  最终 Message、按 Run usage、共享文件、精确取消和 Key 隔离全部通过；耗时约 65 秒。

## 2026-07-30 v4 平台底座结果

- v4 不可变 build 为
  `agent-online-pi-goose-runtime:06295331-78c7-46db-ab18-d763a51bae6c`。构建探针验证
  Node/npm/pnpm、Pi/Goose、Python/pip、Git/Bash、rg/jq、归档、进程诊断、编译器和
  平台 Vite；`/opt/agent-online` 及 manifest 对运行用户只读，`/workspace` 保持空白可写。
- 真实 E2E 先验证空工作区返回 `entry_missing`，再写入静态入口并由平台固定 Vite
  返回真实 marker；随后在同一沙箱完成 `Pi -> Goose -> Pi -> Goose cancel`、usage、
  文件连续性、精确取消和 Key 隔离。1 个完整用例通过，耗时约 63 秒。
