# 运行时边界：SandboxRuntime 与 AgentRuntime

> 状态：E2B、Pi/Goose 私有 spike、Files、Terminal、Preview 与 Changes 已通过既定验收；2026-07-28 已把 E2B 会话、Changes、Preview 和 SDK 类型拆成内部能力模块。Goose 公开产品路径仍受门控。
> 关联：[ADR-0002](../adr/0002-run-agent-process-and-lease-lifecycle.md) · [ADR-0004](../adr/0004-goose-agent-runtime-spike.md) · [ADR-0005](../adr/0005-controlled-project-terminal.md) · [ADR-0006](../adr/0006-controlled-project-preview.md) · [ADR-0007](../adr/0007-controlled-project-changes.md) · [系统总览](./01-system-overview.md) · [数据与模型](./03-data-auth-and-models.md)

## 1. 当前结论

一个 `SandboxLease` 绑定一个 Project 的当前临时环境。应用级 Lease ID 稳定，供应商实例 ID 只保存在服务端 `provider_ref` 中；浏览器永远看不到供应商 ID、端口、Provider Key 或模型 Key。

运行期有两条独立扩展轴。`SandboxRuntime` 在代码中进一步按能力拆为生命周期、进程、文件、终端、Preview 和 Changes 接口，application 模块只依赖所需能力：

| 端口 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| `SandboxLifecycleRuntime` / `SandboxProcessRuntime` / `SandboxFilesystemRuntime` | 取得或停止当前沙箱、运行通用进程，以及受控文件 IO。组合类型 `SandboxRuntime` 只聚合这三项。 | Pi 协议、D1、Message、模型调用、WebSocket/HTTP 授权。 |
| `SandboxTerminalRuntime` | 创建、resize、输入、读取和明确关闭一个 PTY。 | 浏览器鉴权、D1 互斥、WebSocket 协议或终端历史。 |
| `SandboxPreviewRuntime` | 启动/探测/终止平台固定 Preview，并由服务端受控 fetch 固定端口。 | 任意命令/端口、公开 URL、签名 capability、D1 所有权或 HTML 展示策略。 |
| `SandboxChangesRuntime` | 用固定 Git 命令读取当前 working tree/index 的有界 status 与 staged/unstaged diff。 | 任意 Git 命令/revision/pathspec、Run 归因、历史保存或 repository 修改。 |
| `AgentRuntime` | 以受控进程接口启动某个 Agent，并映射为统一 Agent 事件。 | 创建供应商沙箱、D1 写入、取得 Provider/Gemini 原始 Key。 |

Pi 是默认且已验收的 AgentRuntime。Goose 独立 adapter 已通过组合模板的本地和 Preview Workflow 真实 E2E，但在 ADR-0004 的剩余安全与浏览器验收通过前保持服务端门控。SandboxRuntime 可安装 `fake` 或 `e2b`；`fake` 是本地控制面验证实现，不是 Linux 沙箱，也不执行真实 Agent 二进制。

当前 E2B 实现仍只公开一个 `E2BSandboxRuntime` adapter；内部按变更原因拆为
`e2b-sessions.ts`、`e2b-changes.ts`、`e2b-preview.ts`、`e2b-types.ts` 和 shell helper。
这只是内部内聚，不增加第二个 Provider 服务，也不让 application 依赖 E2B 细节。
Worker 使用独立 `e2b-runtime-factory.ts` 构造 adapter，Files/Terminal/Preview 不再
为了取得 runtime 而初始化完整 RunExecution。

## 2. 当前代码合同

以下类型与 [runtime/contract.ts](../../src/runtime/contract.ts) 和 [agent/contract.ts](../../src/agent/contract.ts) 一致：

```ts
type RuntimeKind = "fake" | "e2b" | "cloudflare-container";

type EnsureLeaseInput = {
  providerRef: string | null;
  projectId: string;
  sandboxLeaseId: string;
};

type SandboxCommand = {
  agentRunId: string;
  args: readonly string[];
  command: string;
  cwd: string;
  env?: Readonly<Record<string, string>>;
};

interface SandboxProcessSession {
  readonly providerProcessRef: string;
  events(): AsyncIterable<SandboxProcessEvent>;
  terminate(reason: "completed" | "cancelled" | "timed_out" | "failed"): Promise<void>;
  write(input: string): Promise<void>;
}

interface SandboxLifecycleRuntime {
  readonly kind: RuntimeKind;
  ensureLease(input: EnsureLeaseInput): Promise<RuntimeHandle>;
  stop(handle: RuntimeHandle, reason: SandboxStopReason): Promise<void>;
}

interface SandboxFilesystemRuntime {
  readonly filesystemScope: "lease" | "runtime-instance";
  readonly kind: RuntimeKind;
  listDirectory(handle: RuntimeHandle, path: string): Promise<SandboxFileEntry[]>;
  readFile(handle: RuntimeHandle, path: string): Promise<Uint8Array>;
  writeFile(handle: RuntimeHandle, path: string, content: string): Promise<void>;
}

interface SandboxProcessRuntime {
  readonly kind: RuntimeKind;
  startProcess(handle: RuntimeHandle, command: SandboxCommand): Promise<SandboxProcessSession>;
  terminateProcess(handle: RuntimeHandle, providerProcessRef: string, reason: ProcessTerminationReason): Promise<void>;
}

interface SandboxRuntime
  extends SandboxFilesystemRuntime,
    SandboxLifecycleRuntime,
    SandboxProcessRuntime {}

interface SandboxTerminalRuntime {
  readonly kind: RuntimeKind;
  startTerminal(
    handle: RuntimeHandle,
    input: { cols: number; rows: number; cwd: string },
  ): Promise<SandboxTerminalSession>;
  terminateTerminal(
    handle: RuntimeHandle,
    providerProcessRef: string,
    reason: TerminalCloseReason,
  ): Promise<void>;
}

interface SandboxPreviewRuntime {
  readonly kind: RuntimeKind;
  fetchPreview(
    handle: RuntimeHandle,
    port: number,
    request: { headers: Readonly<Record<string, string>>; method: "GET" | "HEAD"; pathAndQuery: string },
  ): Promise<Response>;
  isPreviewRunning(
    handle: RuntimeHandle,
    providerProcessRef: string,
    port: number,
  ): Promise<boolean>;
  startPreview(
    handle: RuntimeHandle,
    input: SandboxPreviewStartInput,
  ): Promise<{ providerProcessRef: string }>;
  terminatePreview(
    handle: RuntimeHandle,
    providerProcessRef: string,
    reason: "client_stopped" | "expired" | "failed",
  ): Promise<void>;
}

interface SandboxChangesRuntime {
  readonly kind: RuntimeKind;
  listChanges(handle: RuntimeHandle): Promise<SandboxChangesSnapshot>;
  readChangeDiff(
    handle: RuntimeHandle,
    change: SandboxChangeEntry,
  ): Promise<SandboxChangeDiff>;
}
```

```ts
type AgentRuntimeCapabilities = {
  modelGateway: boolean;
  processTermination: boolean;
  stdin: boolean;
  streamingOutput: boolean;
  tty: boolean;
};

interface AgentExecution {
  readonly providerProcessRef: string;
  cancel(reason: "completed" | "cancelled" | "timed_out" | "failed"): Promise<void>;
  events(): AsyncIterable<AgentEvent>;
}

interface AgentRuntime {
  readonly capabilities: AgentRuntimeCapabilities;
  readonly id: "pi" | "goose" | "claude-code" | "codex-cli";
  start(
    context: {
      files: { write(path: string, content: string): Promise<void> };
      processes: { start(command: SandboxCommand): Promise<SandboxProcessSession> };
    },
    input: AgentRunInput,
  ): Promise<AgentExecution>;
}
```

`AgentRunInput` 只带 Project、Run、应用 Lease ID、工作目录、用户任务和短时 ModelGateway capability。它不包含 Provider 管理凭据、真实 sandbox ID 或 Gemini Key。Pi 适配器实现 RPC JSONL、最终可见文本提取、工具事件归一化、abort 与进程终止；Goose adapter 只能实现自己的固定 headless JSONL 协议，不能复用 Runtime ID 生成任意命令。

## 3. 当前生命周期

当前 `RunCoordinator` 的实际状态收敛是：

```mermaid
stateDiagram-v2
    [*] --> stopped
    stopped --> starting: Workflow 领取 Run
    starting --> ready: 沙箱已取得并持久化私有引用
    ready --> busy: Agent 进程已启动
    starting --> failed: 启动失败
    ready --> failed: Agent 启动失败
    busy --> idle: Run 成功、失败或取消
    busy --> failed: 运行期无法收敛 Lease 状态
    idle --> stopped: 空闲 Workflow 原子认领并停止
```

当前实现能验证：

1. 每个 Project 只有一条逻辑 Lease。
2. D1 部分唯一索引与 Terminal trigger 保证每个 Project 同时最多一个非终态 Run 或一条 Terminal 硬锁。
3. Pi/Goose 适配器都通过受控进程接口得到事件；Goose 只在 `spike` 或 `public` 策略下加入可执行 registry，只有 `public` 才加入公开能力；E2B 适配器支持重连当前沙箱、启动进程与 PTY、按私有 PID 终止、固定 Preview fetch、受控 Git Changes 和停止沙箱。
4. SSE 在自己的请求内轮询 D1，只返回应用级 `sandboxLeaseId`、Run 状态和终态；不跨请求搬运原始进程输出。
5. Cloudflare Workflow 拥有长生命周期执行、deadline 和空闲 TTL；取消请求使用 D1 中的私有进程引用跨请求终止当前 Agent。

当前仍不实现每用户活动沙箱上限；Project Preview 已实现，但只支持 ADR-0006 的固定 `vite-v1` preset。

## 4. 只读 Files 边界

`ProjectFilesService` 只接受 Project ID 和相对 `/workspace` 的路径。它不会调用
`ensureLease()`，因此浏览文件不会创建或替换沙箱。只有 `filesystemScope=lease`
且 Lease 状态为 `idle` 或 `ready` 的 Runtime 可以读取；fake 的文件仅存在于
一次 `createServerServices()` 创建的实例内，跨请求没有连续性，所以返回
application outcome `sandbox_unavailable`，HTTP adapter 映射为 `sandbox.not_active`。

第一版限制为：

- 路径最多 512 字符、32 层，逐段拒绝空段、`.`、`..`、反斜线、控制字符和 `.git`；
- 逐层列目录并拒绝符号链接，目录最多返回 500 项；
- 文件最多 256 KiB，只返回合法 UTF-8 文本并拒绝明显二进制内容；
- Project 有非终态 Run 时 application 返回 `project_busy`，普通 API 映射为
  `project.busy`；
- API 和 UI 不返回 Provider ID、内部绝对路径或符号链接目标。

活动 Run 检查、Lease 读取和 Provider 文件读取不是一个原子事务；逐层检查与最终
读取也存在低概率 TOCTOU。个人项目阶段把 Files 定义为无活动 Run 下的尽力一致
只读视图，不把它当作严格并发锁。Terminal 和 Preview 都使用自己的 D1 临时所有权
与生命周期，不把 Files 检查当作安全锁。

## 5. 受控 Terminal 边界

`ProjectTerminalService` 先按 Lease `updated_at/provider_ref` 快照原子 claim
`terminal_sessions`，并成功创建 durable expiry Workflow 后，才取得或创建当前
Lease 沙箱并启动 E2B PTY。它固定 `/workspace`，限制尺寸、单条输入、待消费输出、
累计输出和 30 分钟最长会话。Hono WebSocket 只负责同源认证、Project 授权、协议
校验和字节中继。

活动 Terminal 期间：

- D1 trigger 拒绝新 AgentRun；
- Files 与手动 Stop 的普通 API 返回 `project.busy`；Terminal WebSocket 控制协议仍
  使用自己的 `project_busy` code；
- Run/Terminal idle cleanup 的原子 claim 会失败；
- 浏览器只看到 `ready`、PTY bytes、`closed` 和通用错误码。

关闭或断线时，PTY 先确认终止；D1 在一个 batch 内将同一 Lease 标为 `idle` 并
删除临时行。PTY kill 失败时必须先停止该 session 记录的整个 Provider sandbox；
两次终止都失败则保留临时行并隔离 Lease，不能按 `expires_at` 放行。随后 Workflow
按释放时 `updated_at` 等待 10 分钟并尝试停止仍未被复用的沙箱。终端输入、输出
和滚屏从不进入 D1。

## 6. 受控 Preview 边界

`ProjectPreviewService` 只在 Project 已有 `idle|ready` E2B Lease、且没有活动
AgentRun/Terminal 时 claim 一条 `preview_sessions`。`starting` 行通过 D1 trigger
阻止新 Run；固定 Vite 进程进入 `running` 后，后续 Run 和 Terminal 可以复用同一
`/workspace`，让用户修改后手动 Reload。活动 Preview 始终阻止整沙箱手动 Stop 和
idle cleanup。

`SandboxPreviewRuntime` 只接收平台生成的 `vite-v1` 参数：

- 工作目录 `/workspace`、固定端口 `3000`、固定平台 Vite 二进制
  `/opt/agent-online/preview/node_modules/.bin/vite`；
- 启动前只读检查根目录普通文件 `index.html`；小型 `package.json` 声明依赖但没有
  `node_modules` 时返回产品前置条件错误，不申请 PreviewSession；
- 不执行 Project script、不加载 Project Vite config、不通过 `npx` 下载；
- E2B public traffic 关闭，Provider traffic token 只在 Worker adapter 内使用；
- 单次 Preview 内容代理到 E2B 的 fetch 有 15 秒 deadline；
- config 文件 RPC 瞬时失败时先重连重试，最后只允许平台固定内容和固定 `/tmp`
  路径的受控写入 fallback，不能传入用户命令或 Key。

浏览器只通过绑定 Project、PreviewSession 和 expiry 的同源短时 capability 发起
GET/HEAD。Worker 移除 Cookie、Authorization、Provider Location/host/control header，
并以 iframe sandbox 和 CSP 禁止 WebSocket、form、弹窗及顶层导航。Vite 8 固定
`@vite/client` 资源由平台最小 style runtime 替代，只负责初始 CSS 注入，不建立 HMR
连接。30 分钟 expiry、显式 Stop、进程消失和停止后的 10 分钟 Lease idle cleanup
由 Workflow/应用服务收敛；D1 不保存页面、日志、截图或访问历史。

## 7. 只读 Changes 边界

`ProjectChangesService` 只接受 Project ID，以及列表中刚读取出的精确相对路径。它不调用
`ensureLease()`，不初始化 Git，也不接收 command、revision、cwd、env 或任意 pathspec。
活动 AgentRun/Terminal 时 application 返回 `project_busy`、普通 API 映射为
`project.busy`；Preview running 可以共存。活动检查、
Lease 读取、status 与 diff 不是事务，因此结果只表示请求时的尽力一致当前视图。

E2B 实现固定 `/workspace/.git` 和系统 Git/Bash/coreutils 路径，以空环境运行；
忽略 system/global config，拒绝 `commondir`、`config.worktree` 和
`extensions.worktreeConfig`，并在每次读取前拒绝 include、filter、external diff、
textconv、fsmonitor、attributesFile、hooksPath 和 worktree 覆盖。status 最多 500 项/
128 KiB，staged 与 unstaged diff 各最多 128 KiB；输出经 pipe 直接截断，不写无界临时
文件。浏览器只能读取 status 中仍存在的路径，响应使用 `private, no-store`。被路径
策略过滤的合法 Git 条目通过 `unsupportedEntries` 明确标记，不能显示为 clean。

fake Runtime 不提供 Changes。D1 不新增表；平台不保存 diff、Git 历史或 Run 前后快照，
所以 Changes 不能表示“某次 Run 产生的文件”。

## 8. 已注册与预留 Runtime

| Runtime | 当前状态 | 能否让用户选择 |
| --- | --- | --- |
| Pi | 默认且已验收；支持 fake 控制面与真实 E2B 执行。 | 当前执行路径；选择 UI 随第二 Runtime 一起设计。 |
| Goose | 独立 adapter、组合模板、ModelGateway、文件连续性、D1、usage、取消、deadline 与 TTL 的本地/Preview E2E 已通过；输出脱敏和浏览器验收待完成。 | 当前不可以。 |
| Claude Code | 仅预留 Runtime ID。 | 不可以。 |
| Codex CLI | 仅预留 Runtime ID。 | 不可以。 |

新增适配器前必须独立验收镜像安装、模型凭据路径、事件映射、取消、日志脱敏、网络策略和沙箱隔离。不能因为 Runtime ID 已存在就把它暴露给用户。

## 9. 后续扩展要求

已完成：

- Cloudflare Workflow 的执行所有权、重试恢复、跨请求取消、deadline 和空闲 TTL。
- 真实 Provider sandbox ID 和 process reference 的私有持久化与失效处理。
- Pi RPC 的最终回复、受控 ModelGateway 通道和真实 usage 聚合。
- E2B template 必须以 `E2B_TEMPLATE_ID` 指向项目维护的精确 build。当前 v4 组合模板
  在同一镜像中固定 Node/Pi/Goose、npm/pnpm、Python/pip、Git/Bash、rg/jq、归档/
  进程诊断/原生编译工具和只读平台 Preview Vite，并通过
  `/opt/agent-online/manifest.json` 描述平台能力。E2B 默认非 root 用户必须拥有可写的
  `/workspace`，模板探针需实际完成工具版本、目录权限和 Git init/status。不能按 Agent
  切换模板、在每个 Run 下载二进制，或把任何模型 Key 烘焙进 template。
- wall-clock timeout、空闲 TTL 与明确的资源释放路径。
- 固定 `vite-v1` Preview、同源 GET/HEAD 内容网关、D1 临时所有权、30 分钟 expiry 与停止后的 idle cleanup。
- 固定 Git status/diff、危险 repository 配置拒绝、输出截断、no-store 和桌面/移动端 Project Inspector。

当前仍需持续观察 Cloudflare 远程环境中复杂任务对 Workflow Free CPU、steps 和 subrequest 上限的影响。每用户全局配额和管理视图不属于当前实现，不能被文档或 UI 当作已有护栏。

执行协调设计见 [ADR-0003](../adr/0003-agent-run-workflow.md)。在受控 API 完成前，不得向浏览器开放 Provider ID、内部端口或任意 shell 命令。

## 10. 非目标

- R2 快照、Project 文件版本、沙箱历史或完整原始执行归档。
- 浏览器直连 Provider、模型 API 或沙箱内部端口。
- 任意 Preview command/port、应用后端 API 代理、公开分享链接或持久部署。
- 常驻 Agent session、跨 Run resume 或未授权的任意 CLI。

## 11. 外部依据

- [Pi RPC](https://pi.dev/docs/latest/rpc) 与 [Pi Provider 配置](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)
- [Goose repository](https://github.com/aaif-goose/goose) 与 [Goose CLI commands](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/goose-cli-commands.md)
- [E2B Sandbox 文档](https://e2b.dev/docs/sandbox)
- [E2B PTY 文档](https://e2b.dev/docs/sandbox/pty)
- [Cloudflare Workers WebSocket](https://developers.cloudflare.com/workers/runtime-apis/websockets/)
- [Cloudflare Containers](https://developers.cloudflare.com/containers/)
