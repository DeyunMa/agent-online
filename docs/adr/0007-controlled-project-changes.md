# ADR-0007：以固定 Git 命令提供受控只读 Project Changes

- 状态：Accepted；实现、私有部署与真实 E2E 已完成
- 日期：2026-07-26
- 关联：[ADR-0002](./0002-run-agent-process-and-lease-lifecycle.md) · [ADR-0005](./0005-controlled-project-terminal.md) · [ADR-0006](./0006-controlled-project-preview.md) · [运行时边界](../architecture/02-sandbox-runtime.md)

## 背景

Agent Online 需要在 Project Inspector 中展示当前沙箱 `/workspace` 的真实代码变更，
但 V1 不保存文件快照、Revision、原始 Agent transcript 或 Git 历史副本。浏览器也不能
提交任意命令、revision、pathspec、Provider sandbox ID 或内部路径。

Changes 因此不是平台版本系统，也不是通用 Git API。它只读取当前 Project 唯一沙箱中
现有 Git repository 的工作树和 index，帮助用户检查当前事实。它不能把变更归因到
某一次 AgentRun：连续 Run、Terminal 和用户操作都可能修改同一工作树。

## 决策

### 1. Changes 是独立只读 Runtime capability

新增 `SandboxChangesRuntime`，只提供：

- 读取当前 repository 的受控 status；
- 为 status 中仍存在的精确文件读取 staged/unstaged unified diff。

它不进入 `AgentRuntime`，也不扩大只关心 Files、Terminal 或 Preview 的调用方接口。
E2B adapter 可以由同一个类实现该 capability，但 application 层只能依赖窄接口。
fake Runtime 不伪装 Git repository，公共 Changes capability 明确不可用。

### 2. 只运行平台固定 Git 命令

Runtime 固定使用 `git status --porcelain=v1 -z` 和 `git diff`。浏览器不能传入 command、
args、revision、cwd、环境变量或 limit。执行时必须：

- 固定工作目录 `/workspace`；
- 只接受普通目录 `/workspace/.git`，不向父目录发现 repository，也不跟随 `.git`
  文件或符号链接；
- 固定使用 `/usr/bin/git`、`/bin/bash`、`/usr/bin/env` 和 `/usr/bin/head`；
- 以 `env -i` 启动，设置 `GIT_OPTIONAL_LOCKS=0`、`GIT_NO_LAZY_FETCH=1`、
  `GIT_CONFIG_NOSYSTEM=1`、`GIT_ATTR_NOSYSTEM=1`，并把全局配置固定为 `/dev/null`；
- 拒绝 `.git/commondir`、`.git/config.worktree` 和
  `extensions.worktreeConfig`，不允许实际命令引入校验范围外的 repository config；
- 每次 status/diff 前以 `--no-includes` 解析本地配置；发现 include、`filter.*`、
  external diff、textconv、fsmonitor、attributesFile、hooksPath 或 worktree 覆盖即拒绝；
- 关闭 pager、external diff、textconv、fsmonitor 和 submodule traversal；
- 使用 `--literal-pathspecs` 与 `--`，并只接受刚从 status 解析出的精确相对路径；
- 对 shell 参数做逐项引用，不拼接用户输入；
- status 原始输出最多读取 128 KiB、最多公开 500 项；
- staged 和 unstaged diff 各最多公开 128 KiB，超过时明确标记截断；
- 不输出 ignored 文件、`.git` 内容、绝对路径、Provider 字段或命令 stderr。

固定 shell 用 pipe 把 Git stdout 直接交给固定 `/usr/bin/head`，达到边界时由 SIGPIPE
终止上游，不先写无界临时文件，也不让 Provider SDK 把完整 diff 收进 Worker 内存。
Git 对 symbolic link 只展示 link 自身的变更，不由平台解引用目标。

### 3. 平台不创建或修改 repository

Changes 不执行 `git init`、`git add`、commit、checkout、reset、clean、restore 或任何
写操作。`/workspace` 不是 Git repository 时返回正常的 `repository=false` 空态，不把
它伪装成错误或自动初始化。

状态只描述当前事实：

- `added`
- `modified`
- `deleted`
- `renamed`
- `untracked`
- `conflicted`
- `type_changed`

每项分别保存可空的 `stagedKind` 与 `unstagedKind`。diff 分成 staged 与 unstaged
两段，避免把 index 和工作树语义混在一起。binary diff 只显示 Git 的二进制差异提示，
不传输文件字节。

### 4. 复用 Project 授权与活动边界

公共 API 为：

```text
GET /api/projects/:projectId/changes
GET /api/projects/:projectId/changes/content?path=<relative-path>
```

两条路径都要求 Better Auth 和 Project 所有权。Changes 只附着已有、具有 Lease 级
连续性的 E2B 沙箱，不因查看创建或替换沙箱。无存活 Lease 返回
`sandbox_unavailable`。

活动 AgentRun 或 Terminal 期间返回 `project_busy`，避免与写文件并发。运行中的
Preview 可以共存，因为它已有独立进程所有权，Changes 本身不修改工作树。活动检查、
Lease 读取、status 和 diff 不是文件系统事务；V1 将其定义为个人项目下的尽力一致
快照，不宣称严格并发安全。

### 5. 浏览器只展示真实 API 数据

Project Inspector 只有在服务端公开 `changesEnabled=true` 时启用 Changes tab。界面必须
覆盖 loading、无沙箱、busy、非 Git repository、clean、changed、truncated、
unsupported paths 和 error 状态。被路径策略过滤的合法 Git 条目通过
`unsupportedEntries=true` 明确提示，不能误报 working tree clean。点击 status 中的
文件才能请求 diff；不能手输路径、revision 或命令。

列表展示真实 kind 与 staged/unstaged，详情使用有界、只读 unified diff。前端不根据
消息、Files 或 Preview 内容推测变更，也不生成示例 diff。

## 未采用方案

| 方案 | 不采用原因 |
| --- | --- |
| D1/R2 保存每次 Run 的文件或 diff | 引入平台历史、清理和一致性负担，违反当前轻量边界。 |
| 浏览器传任意 Git 命令或 revision | 扩大命令执行面，并可能读取非当前工作树数据。 |
| 自动 `git init` 或 commit | Changes 应为只读观察能力，不能偷偷修改用户项目。 |
| 复用 Terminal 执行 Git | Terminal 是交互通道，没有 Changes 所需的固定协议和输出上限。 |
| 只比较 AgentRun 前后文件 | 需要快照或长期进程状态，且无法表达 staged/index 语义。 |

## 验收

1. 非所有者不能读取 status 或 diff。
2. 无沙箱、活动 Run/Terminal、非 Git repository 和 Provider 故障都有明确状态。
3. clean、staged、unstaged、untracked、deleted、renamed、conflicted 和 binary 事实
   能稳定映射，超量 status/diff 明确截断。
4. 路径穿越、`.git`、控制字符、绝对路径和不在当前 status 中的 path 被拒绝。
5. 请求前后 Git index、工作树和 D1 不因 Changes 读取而变化。
6. 浏览器响应、日志和 UI 不出现 Provider ID、内部绝对路径、命令 stderr 或 Key。
7. 桌面与移动 viewport 中列表和 diff 可达、可滚动且不遮挡其他控制。
8. `commondir`、worktree config 和主配置中的危险扩展都在 status/diff 前拒绝；
   被过滤路径必须显示结果不完整。

## 验收结果

2026-07-26 的私有 Cloudflare Preview 使用真实 E2B 组合模板完成：

- 同一 repository 的 staged rename、unstaged modification、untracked、binary 和
  大 diff 截断；
- 恶意 `filter.*` 配置被拒绝且标记命令未执行，清理配置后 Changes 恢复；
- `.git/config.worktree` 中的恶意 textconv 同样被拒绝，Files 确认标记文件未生成；
  清理额外 config scope 后，反斜线合法文件名显示“部分变更隐藏”而不是 clean；
- 临时移走 `.git` 时显示非 repository，恢复后重新读取；
- 列表与详情响应均为 `Cache-Control: private, no-store`，响应体未出现 Provider、
  E2B、内部端口或 Key 字段；
- `390x844` 使用页头入口打开 Project Inspector 抽屉，初始焦点进入抽屉且关闭后恢复；
  跨过 `760px` 断点时 modal 语义与焦点约束解除，桌面保持三栏；
- 最终测试 Lease 为 `stopped`，Provider 引用清空，Terminal/Preview 临时行均为 0。

自动验证结果为 190 tests passed、1 个 opt-in 外部 E2E skipped；Pi/Goose 组合模板的
真实 Gemini E2E 另行通过。当前 E2B build 显式安装并探测 Git、Bash、coreutils、
Node、Pi 和 Goose。

## 后果

Changes 新增一项窄 Runtime capability、一项 application service、一组同源 GET API 和
一个 React Inspector view；不增加 D1 表、迁移、环境变量、Secret、外部服务、R2、
Workflow、Durable Object 或第二个 Worker。
