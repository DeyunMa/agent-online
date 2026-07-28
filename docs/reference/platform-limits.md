# 平台限制与限制对象

> 文档状态：当前实现限制基准
>
> 校准日期：2026-07-28
>
> 目标：说明每一类限制约束什么对象、当前值、由哪一层执行，以及达到限制后的行为

本文同时记录三种“限制”：

1. **硬限制**：代码、D1 约束或签名 capability 强制执行。
2. **产品边界**：当前版本有意不提供的能力。
3. **外部限制**：Cloudflare、E2B 和 Gemini 套餐/配额，项目只能观察，不能保证。

未特别说明时，数值是当前代码默认值，不是永久兼容承诺。

## 1. 资源和并发限制

| 限制对象 | 当前限制 | 执行层 | 达到限制后的行为 |
| --- | --- | --- | --- |
| Project 所有权 | 一个 Project 只属于一个 User | D1 FK + 所有权查询 | 非所有者统一得到 `404`。 |
| SandboxLease | 每个 Project 最多一行逻辑 Lease | `UNIQUE(project_id)` | 复用已有 Lease，不创建第二条。 |
| Provider sandbox | 每个 Project 同时最多一个活动 Provider sandbox | Lease `provider_ref` + 条件更新 | 连接现有沙箱或等待/失败；不创建分支沙箱历史。 |
| AgentRun | 每个 Project 同时最多一个非终态 Run | D1 部分唯一索引 | 普通 API 返回 `409 project.busy`。 |
| Terminal | 每个 Project 最多一个 TerminalSession | `UNIQUE(project_id)` | WebSocket 返回 `project_busy` 后关闭。 |
| Preview | 每个 Project 最多一个 PreviewSession | `UNIQUE(project_id)` | 普通 API 返回 `409 project.busy`。 |
| assistant Message | 每个 AgentRun 最多一条最终回复 | D1 部分唯一索引 | 重复完成不会写第二条。 |
| Run 跨表归属 | User、Project、Lease、Runtime、输入 Message 必须一致 | D1 trigger | 整个创建 batch 回滚。 |
| Run 状态迁移 | 只能走领域状态机，终态不可变 | application + D1 trigger | 非法更新中止。 |
| Run failure code | 必须与当前 status 构成合法组合 | D1 trigger | 非法插入或更新中止。 |
| Terminal/Preview Lease | 临时行必须引用同 Project Lease；Preview Provider ref 还必须匹配 Lease | D1 trigger | claim/insert 中止。 |

### 1.1 操作互斥矩阵

`阻止` 表示目标操作不能在该活动存在时开始；`允许` 表示当前设计允许并行。

| 目标操作 | 活动 AgentRun | 活动 Terminal | Preview starting | Preview running |
| --- | --- | --- | --- | --- |
| 创建 AgentRun | 阻止 | 阻止 | 阻止 | 允许 |
| 打开 Terminal | 阻止 | 阻止 | 阻止 | 允许 |
| 启动 Preview | 阻止 | 阻止 | 阻止 | 阻止 |
| 读取 Files | 阻止 | 阻止 | 允许 | 允许 |
| 读取 Changes | 阻止 | 阻止 | 允许 | 允许 |
| 手动停止整个 sandbox | 阻止 | 阻止 | 阻止 | 阻止 |
| 停止 running Preview | 允许 | 允许 | starting 状态自身阻止 | 目标操作 |

Run 与 Terminal 的互斥同时存在于应用层和 D1。Files/Changes 的活动检查与后续外部读取不是原子事务，因此属于尽力一致性，不能解释成严格快照隔离。

## 2. 认证和部署开关

| 限制对象 | 当前限制 | 配置/执行 |
| --- | --- | --- |
| 登录方式 | 只启用邮箱密码 | Better Auth `emailAndPassword.enabled=true` |
| 浏览器密码输入 | 至少 8 个字符 | React 表单；服务端仍以 Better Auth 校验为准 |
| 注册/登录访问模式 | `open` 或 `allowlist` | `ACCESS_MODE` |
| allowlist | 逗号分隔、trim、转小写；至少一个邮箱 | `ACCESS_ALLOWED_EMAILS` |
| 受信任来源 | `BETTER_AUTH_URL` 单一 origin | Better Auth `trustedOrigins` |
| 普通产品 mutation | 必须有精确同源 `Origin`，或浏览器提供 `Sec-Fetch-Site: same-origin` | Hono 外层 guard；Better Auth 与 ModelGateway 使用各自协议 |
| Run 总开关 | 默认开启；可完全禁止新 Run | `RUNS_ENABLED` |
| 签名 secret | capability codec 要求至少 32 个字符 | `BETTER_AUTH_SECRET` |
| 第三方登录 | 未启用 | 当前无 Google/GitHub OAuth 配置 |

allowlist 同时检查邮箱注册和邮箱登录。它是私有部署入口控制，不是 Team invite 系统。

当前没有应用级 IP/User 速率限制、验证码、封禁、并发用户额度或滥用检测；只能继承 Better Auth、Cloudflare 和上游 Provider 的平台行为。这是公开部署前必须重新评估的边界。

## 3. Project、消息和列表

| 限制对象 | 当前值 | 执行层 |
| --- | --- | --- |
| Project 标题 | trim 后 1 至 120 个 JavaScript string 单元 | Hono/Zod |
| Project 删除 | 活动 Run、Terminal 或 Preview 时拒绝；成功后不可恢复 | Application 用例 + D1 FK |
| AgentRun 用户输入 | trim 后 1 至 64,000 个 JavaScript string 单元 | Hono/Zod |
| 普通产品请求体 | 最多 256 KiB | Hono body limit；超限返回 `413 request.too_large` |
| Project 列表 | 无分页、无应用级条数上限 | D1 查询 |
| Message 列表 | 无分页，返回 Project 全部可见消息 | D1 查询 |
| AgentRun 列表 | 只返回最新 50 条 | D1 `LIMIT 50` |
| Usage 范围 | 当前 User 现存 AgentRun，固定 `all_time`；Project 删除后相应减少 | D1 聚合 |
| 默认模型 ID | 最长 200，只允许 `[A-Za-z0-9._:/-]` | Worker 配置解析 |

当前没有 Project 数量、Message 数量或 D1 总存储的产品配额。Project/Message 无分页适合个人阶段，但数据变大后会增加响应和 D1 扫描成本。

普通产品 mutation 在鉴权和业务 JSON 解析前统一执行同源检查与 256 KiB body limit。
Better Auth 和内部 ModelGateway 不经过该 guard，分别使用自身来源/协议校验与
ModelGateway 的 4 MiB 实际读取上限。公开注册前仍需增加独立的 rate limit/abuse
策略；请求体上限不能替代滥用防护。

## 4. AgentRun、Workflow 和沙箱时间

| 限制对象 | 默认值 | 可配置范围/固定上限 | 作用 |
| --- | --- | --- | --- |
| Run wall time | 1,800 秒 | `MAX_RUN_WALL_SECONDS`：1 至 3,600 秒 | 到期后取消进程并收敛为 `timed_out`。 |
| Sandbox idle TTL | 600 秒 | `RUNTIME_IDLE_TTL_SECONDS`：1 至 86,400 秒 | 最后一次 Run/Terminal/Preview 释放后回收沙箱。 |
| Agent 进程 Provider timeout | Run wall time + 15 秒 | 派生值 | 给应用取消和状态收敛留缓冲。 |
| E2B sandbox timeout | 最长活动时长 + idle TTL + 60 秒 | 派生值 | Provider 侧最终回收上限；默认约 41 分钟。 |
| Workflow execute step timeout | Run wall time + 30 秒 | 派生值 | 限制 durable execute step。 |
| Workflow execute 重试 | 1 次，固定 2 秒退避 | 固定 | 重试后由恢复逻辑收敛。 |
| idle cleanup 重试 | 1 次，固定 2 秒退避 | 固定 | Provider timeout 是最终边界。 |
| Terminal/Preview expiry 重试 | 2 次，固定 2 秒退避 | 固定 | 失败时保留可观察状态或依赖 Provider timeout。 |
| Workflow ID | 1 至 100 字符 | 固定 | 拒绝非法 payload。 |
| Workflow 时间戳 | 20 至 40 字符且可解析 | 固定 | 拒绝非法 payload。 |

沙箱停止不是永久 Project 删除。停止会清空 Provider 引用，Project 元数据、Message、Run 和 usage 仍在 D1，但 `/workspace` 文件允许丢失。

Project 硬删除会先停止空闲沙箱，再删除 Project 聚合。Message、Run、Usage 和 Lease
随 D1 外键删除，`/workspace` 文件永久丢失；当前没有回收站或恢复副本。

## 5. AgentRuntime 和模型限制

| 限制对象 | 当前值 | 说明 |
| --- | --- | --- |
| 默认公开 Runtime | `pi` | `/api/capabilities` 和 UI 只公开 policy 允许的 Runtime。 |
| Goose | `disabled`、`spike`、`public` 三态 | 当前 Preview 为 `spike`：服务端可受控执行，但浏览器不公开。 |
| 保留 Runtime ID | `claude-code`、`codex-cli` | 仅类型预留，没有 adapter 或可执行能力。 |
| 默认模型 | `gemini-3.6-flash` | Worker 平台模型；没有 BYOK。 |
| 单次模型最大输出 | 当前签发 4,096 tokens | capability/gateway 技术上限 65,536。 |
| Pi/Goose 声明 context | 128,000 tokens | adapter 配置值，不保证上游一定接受所有上下文。 |
| Goose 最大回合 | 25 turns | `GOOSE_MAX_TURNS` 固定注入。 |
| capability 生命周期 | 与 Run deadline 对齐，最长 3,600 秒 | 过期、Run 非活动或模型不匹配即拒绝。 |
| capability token 长度 | 最长 4,096 字符 | 超限视为无效。 |
| future clock skew | 最多 30 秒 | capability 校验。 |
| ModelGateway 请求体 | 最多 4 MiB | 先检查 `Content-Length`，并对实际 stream 字节数再次设限。 |
| ModelGateway 上游请求 | 120 秒 | deadline 到期返回通用 `504 model_timeout`；非幂等 POST 不自动重试。 |
| ModelGateway 成功响应 | 最多缓冲 8 MiB | 超限或非法 UTF-8 返回通用 `502`。 |
| ModelGateway 错误诊断 | 最多读取 64 KiB | 只记录固定诊断码、分类和上游 HTTP 状态；不记录正文或协议摘要。 |

ModelGateway 的 OpenAI 兼容请求限制：

- `messages`：1 至 256 条。
- `tools`：最多 128 个。
- `n`：只允许省略或 `1`。
- `stream`：只允许 boolean；Pi/Goose 可使用流式响应。
- message role：只允许 `assistant`、`developer`、`system`、`tool`、`user`。
- 请求模型必须等于 Run 的 `model_id`。
- 上游成功响应必须提供合法 usage；否则结果不返回 Agent。

平台 Gemini Key 只在 Worker ModelGateway 内使用。它不能进入模板、沙箱环境、浏览器、D1 或日志。当前也没有用户 Key 加密存储、选择或回退逻辑。

## 6. Files 限制

Files 限制的是浏览器对当前 `/workspace` 的只读观察面，不限制 Agent/Terminal 在沙箱内正常操作文件。

| 限制对象 | 当前值 | 达到限制后的行为 |
| --- | --- | --- |
| 根目录 | 固定 `/workspace` | 不能由浏览器传 cwd。 |
| 路径形式 | 相对路径；最长 512；最多 32 层 | `400 project_path.unsupported`。 |
| 单个路径段 | 1 至 255；拒绝 `.git`、`.`、`..` | `400 project_path.unsupported`。 |
| 路径字符 | 拒绝绝对路径、尾 `/`、反斜杠和控制字符 | `400 project_path.unsupported`。 |
| 符号链接 | 可以作为目录条目显示，但不能遍历或读取 | `project_path.unsupported` / `file.content_unsupported`。 |
| 单目录返回 | 最多 500 个安全条目 | `truncated=true`。 |
| 单文件读取 | 最多 256 KiB | `413 file.too_large`。 |
| 文件编码 | 必须是严格 UTF-8 | `415 file.content_unsupported`。 |
| 二进制启发式 | NUL 直接拒绝；其他控制字符超过 `max(4, 1%)` 时拒绝 | `415 file.content_unsupported`。 |
| Lease | 必须已有 Provider ref，状态为 `ready` 或 `idle`，filesystem scope 为 `lease` | `409 sandbox.not_active`。 |
| 并发 | 活动 Run 或 Terminal 时拒绝 | `409 project.busy`。 |

Files 不支持写入、上传、下载二进制、删除、rename、搜索、压缩、版本或快照。`fake` Runtime 的文件只属于单个内存实例，不能跨请求冒充 Project 文件，因此 Files capability 明确不可用。

逐层 symlink 检查与最终 read 之间存在 Provider 文件系统 TOCTOU；当前设计是个人项目的低风险、尽力防护，不是强隔离文件服务器。

## 7. Changes 限制

Changes 限制的是当前 Git working tree/index 的只读、瞬时视图。

| 限制对象 | 当前值 | 达到限制后的行为 |
| --- | --- | --- |
| repository 根 | 固定 `/workspace` 和 `/workspace/.git` | 不能传 repository/cwd。 |
| `.git` 类型 | 必须是真实目录；config 必须是真实文件 | 非 repository 或通用服务错误。 |
| 额外 Git scope | 拒绝 `commondir`、`config.worktree` 和 `extensions.worktreeConfig` | `503 sandbox.provider_unavailable`。 |
| 危险 Git config | 拒绝 include/includeIf、filter、diff external/command/textconv、fsmonitor、attributesFile、hooksPath、worktree | `503 sandbox.provider_unavailable`。 |
| 进程环境 | `env -i`，固定 PATH/HOME/locale，关闭 system/global config、lazy fetch、prompt、pager 和 optional locks | 调用方不能注入 env。 |
| Git 命令 | 平台固定 `/usr/bin/git` 参数 | 无任意 command/args 接口。 |
| 命令时间 | 每次最多 15 秒 | Provider 错误。 |
| repository config | 最多读取 64 KiB | 超限拒绝。 |
| status 输出 | 最多 128 KiB | `truncated=true`。 |
| status 条目 | 最多 500 | `truncated=true`。 |
| staged diff | 最多 128 KiB | section `truncated=true`。 |
| unstaged diff | 最多 128 KiB | section `truncated=true`。 |
| 路径 | 最长 512、最多 32 层、每段最多 255；拒绝 `.git`、反斜杠、控制字符和穿越 | 隐藏并置 `unsupportedEntries=true`，或拒绝详情。 |
| 并发 | 活动 Run 或 Terminal 时拒绝 | `409 project.busy`。 |
| 缓存 | `private, no-store` | 浏览器不能把旧结果当当前状态。 |

Changes 不支持 commit、checkout、branch、reset、revert、stage、unstage、apply patch、历史 diff 或 Run 归因。`repository=false` 只表示当前工作区不是 Git repository。

安全配置校验与后续 Git 命令之间仍有 TOCTOU；具备沙箱命令执行能力的活动主体理论上可在两步间改配置。因此 Changes 不能作为强安全审计器或一致性证明。

## 8. Terminal 限制

| 限制对象 | 当前值 | 达到限制后的行为 |
| --- | --- | --- |
| 传输 | 同源、已登录 WebSocket | 非同源 `403`；非升级请求 `426`。 |
| 工作目录 | 固定 `/workspace` | 浏览器不能传 cwd。 |
| 首个 attach | 连接后 10 秒内，且只能一次 | `invalid_message` 并关闭。 |
| columns | 20 至 240 | `invalid_message`。 |
| rows | 5 至 100 | `invalid_message`。 |
| 单次输入 | 编码后最多 16 KiB | 连接失败/关闭。 |
| 单个文本 frame | 最多约 17 KiB（16 KiB + 1 KiB 控制开销） | `invalid_message`。 |
| 客户端输入分块 | 8 KiB，8 ms flush | 浏览器实现细节。 |
| 排队控制操作 | 最多 32 个 | `invalid_message` 并关闭。 |
| 待消费输出 | 最多 256 KiB，带 backpressure | 超大单 chunk 或失败时关闭。 |
| 单会话累计输出 | 最多 8 MiB | Provider error 并关闭。 |
| 会话时长 | 最长 30 分钟 | Workflow/本地 timer 终止。 |
| PTY Provider timeout | 30 分钟 | Provider 侧最终终止。 |
| UI scrollback | 2,000 行 | 更早滚屏只在浏览器内丢弃。 |
| 持久化 | 不保存输入、输出和滚屏 | 断开后不可恢复终端历史。 |

Terminal 是受控但真实的 shell。登录用户可以通过它修改 `/workspace`，因此它只适用于 Project 所有者；它不是只读文件浏览器。

## 9. Preview 限制

| 限制对象 | 当前值 | 达到限制后的行为 |
| --- | --- | --- |
| 工作目录 | 固定 `/workspace` | 不能传 cwd。 |
| preset | 固定 `vite-v1` | 不能传任意命令或脚本。 |
| 端口 | 固定 `3000`，D1 CHECK | 其他端口拒绝。 |
| 启动等待 | 最多 20 秒；每 500 ms 探测，单次探测 2 秒 | `503 preview.unavailable`。 |
| 内容代理上游请求 | 每次最多 15 秒 | Provider fetch 超时并映射为 Preview 通用错误。 |
| 会话时长 | 最长 30 分钟 | Workflow 终止进程并删临时行。 |
| 进程 timeout | 会话时长 + 15 秒 | Provider 最终终止。 |
| capability 生命周期 | 最长 30 分钟 | 过期后内容路由返回 `404`。 |
| capability token | 最长 2,048 字符 | 无效 token 返回 `404`。 |
| capability ID | Project/PreviewSession ID 各 1 至 100 字符 | 签发/校验拒绝。 |
| base path | 最长 2,048，固定 Project Preview 前缀 | adapter 拒绝。 |
| 上游 path | path 最长 2,048；path + query 最长 4,096；拒绝 NUL/CR/LF/`..` 段 | `404` 或 Preview 错误。 |
| 方法 | 只允许 `GET`、`HEAD` | 其他方法无路由。 |
| 请求头 | 只转发 accept、编码/语言、缓存条件和 range | Cookie、Authorization 等不转发。 |
| 响应头 | 只转发 range、content type、etag、last-modified 等白名单 | Provider 私有头不外泄。 |
| 浏览器容器 | `<iframe sandbox="allow-scripts">`，不含 `allow-same-origin` | Preview 脚本处于 opaque origin。 |
| CSP | `connect-src 'none'`、`form-action 'none'`、`object-src 'none'` 等 | HMR/WebSocket/外部 fetch 不工作。 |
| 缓存 | `no-store` | 不保证离线或历史内容。 |

Preview 不提供任意端口代理、后端服务、WebSocket/HMR、环境变量、Provider URL、日志、截图或部署。它用于手动刷新查看前端 Vite 输出，不是通用应用托管平台。

## 10. ModelGateway 和密钥边界

| 限制对象 | 当前限制 |
| --- | --- |
| 调用主体 | 只有持有效 Run capability 的沙箱 Agent。 |
| Run 状态 | D1 中必须仍为 `starting` 或 `running`。 |
| scope | 固定 `model:complete`，绑定 Project/Run/Model。 |
| 网络 | 生产 ModelGateway 必须 HTTPS；只允许 localhost/127.0.0.1 使用 HTTP。 |
| Gemini Key | 只在 Worker 到 Gemini 的请求中使用。 |
| Provider 错误 | 对外统一为通用 gateway error，日志只记录分类和状态。 |
| 上游 deadline | 单次 120 秒；不自动重试模型 POST。 |
| usage | 上游必须提供；先写 D1，再把结果返回 Agent。 |
| 缓存 | 所有 gateway 响应 `no-store`。 |

当前没有 BYOK、Key 轮换 UI、Key 按用户隔离、模型价格表或预算强制。`input_tokens` 等字段是 Provider usage 的累计事实，不保证等于最终账单。

## 11. 数据保存和恢复限制

| 数据 | 保存位置 | 当前恢复能力 |
| --- | --- | --- |
| 用户、会话、Project | D1 | 可恢复。 |
| 用户输入和最终 assistant 回复 | D1 | 可恢复。 |
| AgentRun 状态和聚合 usage | D1 | 可恢复并可聚合。 |
| 当前 Lease/Terminal/Preview 协调 | D1 | 用于收敛，不是历史。 |
| Project 文件 | 当前沙箱 `/workspace` | 沙箱丢失后不可恢复。 |
| raw Agent transcript/私有推理 | 不保存 | 不可恢复。 |
| 终端滚屏 | 仅当前浏览器内存 | 断开后不可恢复。 |
| Preview 页面/日志/截图 | 不保存 | 不可恢复。 |
| Git Changes 历史 | 不保存 | 只能重新读取当前状态。 |

没有 R2、对象存储快照、备份恢复、版本历史或多副本一致性。对个人学习项目这是有意的轻量边界，不应宣传成生产级代码托管。

## 12. 当前产品边界

当前版本明确不提供：

- Team、Tenant、Organization、Membership、Project 分享。
- R2 快照、文件版本、回滚、分支沙箱或沙箱历史。
- 持久 Agent Session、raw transcript、工具审计日志。
- BYOK、第三方 OAuth、模型市场或公开 Goose 选择。
- 套餐、支付、订阅、余额、发票、税、退款或账单对账。
- 文件写入 API、任意命令 API、任意端口代理。
- SLA、跨区容灾、数据导出/删除工作流和合规承诺。

代码迭代也不承诺兼容旧的本地数据库、R2 骨架或测试数据；可以清洗本地开发数据并重建 schema。该规则不允许未经确认删除远程 Cloudflare/E2B 资源或未知数据。

## 13. 外部免费层和 Provider 限制

Cloudflare、E2B 和 Gemini 的免费额度、并发、CPU、存储、日志保留和请求配额会变化，不写成代码常量，也不由本项目保证。

当前处理原则：

- Cloudflare Worker、Assets、D1 和 Workflows 的额度由对应 Cloudflare 账号/计划决定。
- E2B 沙箱分钟数、并发和模板构建额度由 E2B 账号决定。
- Gemini token、请求和模型可用性由 Gemini 项目决定。
- 外部配额耗尽可能表现为 `503`、Run `failed` 或 Provider 清理延迟。
- 本项目没有自动预算告警、熔断、降级 Provider 或费用上限。

部署前应在 Provider Dashboard 核对当前计划，而不是依赖本文的历史估算。资源和查看路径见：

- [外部依赖](../setup/external-dependencies.md)
- [Cloudflare Preview 资源台账](../setup/cloudflare-preview-resources.md)
- [环境变量](../setup/environment-variables.md)

## 14. 已接受的剩余风险

| 风险 | 当前结论 |
| --- | --- |
| Files/Changes 检查与 Provider 读取非原子 | 个人阶段接受；UI 不宣称严格一致。 |
| Git config 校验与命令执行存在 TOCTOU | 接受为当前只读观察面限制，不作为安全审计证明。 |
| D1 状态和外部 Provider 可能短暂漂移 | Workflow、条件更新和 Provider timeout 尽力收敛。 |
| Project/Message 无分页 | 个人数据量阶段接受；规模化前必须补。 |
| 无应用级 rate limit/abuse control | 只适合私有 allowlist Preview；公开注册前必须补。 |
| Project 文件无备份 | 当前明确接受；停止沙箱前用户需自行理解数据可丢失。 |
| import boundary 检查不覆盖未来 path alias/计算式动态导入 | 当前 tsconfig 无 alias，现有生产代码满足边界；引入 alias 时需同步门禁。 |
| 浏览器 tab ARIA 模式未覆盖完整 roving/arrow-key 规范 | 不影响当前数据安全；属于后续可访问性完善项。 |
| 浏览器自动化只覆盖核心 smoke | 当前覆盖注册、Project、fake Run 取消和刷新恢复；真实 Terminal/Preview/Changes 仍依赖显式 E2B E2E。 |
| 临时协调状态可能因外部故障漂移 | Workflow/Provider timeout 是正常收敛路径；重复漂移按[协调状态恢复](../operations/coordination-recovery.md)诊断，不能仅凭过期时间删锁。 |

接口结构见 [HTTP、SSE 与 WebSocket 接口](./http-api.md)，数据所有权见 [D1 表设计](./database-schema.md)。
