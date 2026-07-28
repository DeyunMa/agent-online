# Cloudflare 私有 Preview 部署

> 状态：2026-07-28 已部署交付加固版本并通过基线与全能力 Hosted Preview E2E；
> `0006_integrity_guards.sql` 和 `0007_agent_run_failure_codes.sql` 继续保持已应用。
> 本文继续作为后续发布与重建流程。
> 关联：[资源台账](./cloudflare-preview-resources.md) · [环境变量](./environment-variables.md) · [外部依赖](./external-dependencies.md) · [交付阶段与成本](../architecture/04-delivery-and-cost.md)

## 1. Preview 边界

Preview 是用于验证真实 Cloudflare Workflow、E2B 和 Pi 链路的受控环境，不是公开发布：

- 使用 `agent-online-preview` Worker 和独立的 `agent-online-preview-db` D1。
- `ACCESS_MODE=allowlist`，只有 `ACCESS_ALLOWED_EMAILS` 中的邮箱可以注册、登录和访问产品 API。
- 首次部署保持 `RUNS_ENABLED=false`。先验证认证、Project 和页面，再单独打开真实 AgentRun。
- 浏览器仍然不能得到 Gemini/E2B Key、Provider sandbox ID、内部端口或进程引用。
- Preview 与本地配置不共享 Binding、变量或 Secret；所有远程值都必须显式配置。
- 顶层 production 配置仍是占位状态，当前唯一允许的远程目标是 `env.preview`。
  `pnpm deploy` 会先执行 production guard 并拒绝误部署。

## 2. 提交前本地检查

以下命令不创建远程资源：

```sh
pnpm check
pnpm deploy:preview:dry-run
```

`pnpm check` 还执行源码凭据扫描、Biome、真实 Workers/D1 migration 测试和独立 fake 浏览器 smoke。生产和 Preview 构建都会先清理旧 `dist`，再执行内容型 `validate:build-artifacts`；Cloudflare 插件可能在本地构建时探测 `.dev.vars`，但 build 配置不要求本地 Secret，也不会把该文件或其中的凭据序列化进可部署产物。

`pnpm deploy:preview:dry-run` 允许配置中保留远程占位值，以便先验证构建包和 Binding 结构。真实部署前，`pnpm validate:preview-config` 会拒绝：

- 全零的 Preview D1 `database_id`；
- 包含 `replace-me` 的 `BETTER_AUTH_URL`；
- 占位 E2B Template ID；
- 非法或尚未批准的 `GOOSE_RUNTIME_MODE=public`；
- 启用 Goose 时仍使用非组合 E2B Template；
- 非 allowlist 的 Preview 访问模式；
- 非 E2B 的 Preview SandboxRuntime。

真实 `pnpm deploy:preview` 还会执行 `pnpm validate:preview-account`。
`wrangler.jsonc` 的 `env.preview.account_id` 固定目标 Account；调用方若设置了
`CLOUDFLARE_ACCOUNT_ID`，它必须与配置一致，避免本机其他 Cloudflare 环境变量把
命令指向错误 Account。dry-run 不访问远程资源。

## 3. 创建远程资源

以下操作会读取或修改 Cloudflare 账号，执行前必须得到明确授权。当前 Preview 已完成这些步骤；保留本节作为重建和审计依据。

1. 确认 Wrangler 当前身份和目标 Account：

```sh
pnpm wrangler whoami
```

本机存在其他 Account 的 Cloudflare 环境变量，实际 Preview 命令必须使用[资源台账](./cloudflare-preview-resources.md)中的 Account guard。

2. 创建独立 Preview D1：

```sh
pnpm wrangler d1 create agent-online-preview-db
```

3. 将返回的真实 D1 ID 写入 `wrangler.jsonc` 的 `env.preview.d1_databases[0].database_id`。
4. 将 Preview Worker 的最终 HTTPS Origin 写入 `env.preview.vars.BETTER_AUTH_URL`。
5. 将已验证的精确 E2B build reference 写入 `env.preview.vars.E2B_TEMPLATE_ID`。
6. 验证非敏感配置：

```sh
pnpm validate:preview-config
```

不复用顶层 D1 占位配置，也不为 Preview 创建 R2、第二个 Worker 或第二套后端服务。

## 4. 写入 Preview Secret

每条命令通过终端交互输入值，不把值放进命令参数、Git 或文档：

```sh
pnpm wrangler secret put BETTER_AUTH_SECRET --env preview
pnpm wrangler secret put GEMINI_API_KEY --env preview
pnpm wrangler secret put E2B_API_KEY --env preview
pnpm wrangler secret put ACCESS_ALLOWED_EMAILS --env preview
```

`ACCESS_ALLOWED_EMAILS` 是逗号分隔的受邀邮箱。Preview 使用独立的 `BETTER_AUTH_SECRET`；`BETTER_AUTH_URL` 和 `E2B_TEMPLATE_ID` 是非敏感部署变量，不通过 Secret 写入。

## 5. 锁定、排空并迁移

`0006_integrity_guards.sql` 的 assistant Message trigger 要求关联 Run 已经是
`succeeded`。旧 Worker 的完成顺序不满足这个约束，因此不能把 `0006` 先应用到仍
可能由旧 Workflow 写入的数据库。必须使用以下顺序：

本流程已于 2026-07-27 实际执行并通过；当前 Preview 已包含 `0006`。以下步骤保留为
本次审计证据，也作为未来出现同类执行顺序或 trigger 变更时的发布模板。

1. 在 `wrangler.jsonc` 中把 Preview 的 `RUNS_ENABLED` 改为 `"false"`，先部署当前
   新代码。当前代码兼容 `0005` schema，并会在任何 Message、Lease 或 Run 写入前拒绝
   新执行：

```sh
env -u CLOUDFLARE_API_TOKEN \
  CLOUDFLARE_ACCOUNT_ID=66a06222aa0acd9ea509abad73fa02fb \
  pnpm deploy:preview
```

2. 确认 `/api/capabilities` 返回 `runCreationEnabled: false`，等待所有旧的非终态 Run
   和旧版本 Workflow 收敛，并显式关闭当前 Terminal、Preview 和沙箱活动。
3. 执行只读预检。脚本只返回九组计数，不读取 prompt、文件、Provider 引用或 Secret；
   所有计数必须为 `0`：

```sh
env -u CLOUDFLARE_API_TOKEN \
  CLOUDFLARE_ACCOUNT_ID=66a06222aa0acd9ea509abad73fa02fb \
  pnpm release:preview:preflight
```

4. 预检通过后再应用迁移，并确认输出包含 `0006_integrity_guards.sql`：

```sh
env -u CLOUDFLARE_API_TOKEN \
  CLOUDFLARE_ACCOUNT_ID=66a06222aa0acd9ea509abad73fa02fb \
  pnpm wrangler d1 migrations apply DB --remote --env preview
```

5. 保持 `RUNS_ENABLED=false` 完成锁定 smoke。若预检不为零，不迁移、不直接改远程
   数据；先按[协调状态恢复](../operations/coordination-recovery.md)诊断并重新排空。

### 5.1 发布 `0007_agent_run_failure_codes.sql`

`0007` 是 additive schema 变更，但新代码会读取 `failure_code`，而新 trigger 也会
拒绝旧 Worker 写入没有 failure code 的终态。因此远程 Preview 必须按以下维护窗口
发布，不能直接执行普通 deploy：

1. 在**当前已部署版本**上先把 `RUNS_ENABLED` 设为 `false`，不要同时替换为新代码。
2. 等待所有非终态 Run/Workflow 收敛，关闭 Terminal/Preview，并执行只读 preflight。
3. 在锁定状态下应用全部待执行 migration，确认包含
   `0007_agent_run_failure_codes.sql`。
4. 部署本阶段新代码，仍保持 `RUNS_ENABLED=false`。
5. 验证 Project/Run 列表、旧 Run 的 `failureCode`、统一错误体和日志脱敏。
6. 再把 `RUNS_ENABLED` 恢复为 `true` 并执行 Hosted E2E。

如果无法先锁定当前已部署版本，则停止发布；不能在仍可能创建旧格式 Run 时提前应用
trigger，也不能让读取 `failure_code` 的新代码长期运行在旧 schema 上。

本流程已于 2026-07-27 实际执行：迁移前旧代码锁定版本为
`305c1f6a-238e-46c7-85e6-532d05032f54`，新代码锁定版本为
`4a6e38dd-0062-4a18-92a3-f6b93f9ceff0`，最终解锁版本为
`e42fedb1-e386-4427-b283-2ffda2318a9a`。锁定前后九项预检均通过，远程 D1 的
status/failure code 非法组合计数为零，Hosted E2E 通过。

锁定部署必须验证：

1. `/api/health` 正常。
2. `/api/capabilities` 返回 `runCreationEnabled: false`。
3. allowlist 邮箱可以注册、登录、创建和读取自己的 Project。
4. 非 allowlist 邮箱无法注册或登录。
5. 新建 Run 按钮和输入框禁用；直接调用创建 Run API 也返回
   `run.creation_disabled`，且不写入 Message、Lease 或 AgentRun。

## 6. 打开真实 Run

锁定验收和迁移都通过后，将 `env.preview.vars.RUNS_ENABLED` 改为 `"true"` 并再次
执行带显式 Account guard 的 `pnpm deploy:preview`。随后先执行
[Hosted Preview E2E](../testing/hosted-preview-e2e.md)，再按需做更长的人工成本探针：

1. 创建 Project 并运行一个最小 Pi 任务。
2. 确认 Workflow 从 `queued` 收敛到终态，最终 assistant Message 和真实 usage 写入 D1。
3. 运行较长任务并取消，确认只终止当前 Agent 进程。
4. 再次运行，确认存活沙箱可复用；手动停止后确认 Project 文件允许丢失。
5. 等待空闲 TTL，确认旧 Lease 不会错误停止新 Run 正在使用的沙箱。
6. 检查 Cloudflare Workflow 的 step CPU、subrequest 和失败日志，决定 Free 计划是否能承载典型任务。

任何异常成本、授权或执行问题都先把 `RUNS_ENABLED` 改回 `"false"` 并重新部署，不删除远程数据或资源。

受控 Project Preview 另按以下顺序验收：

1. 确认数据库已包含 `0005_preview_sessions.sql`；新建环境应一次应用全部迁移，现有
   Preview 则按第 5 节依次补未应用迁移，当前最新为
   `0007_agent_run_failure_codes.sql`。随后确认
   `/api/capabilities` 仅公开 `previewEnabled=true`，不公开内部端口或 Provider 字段。
2. 在已有空闲 E2B Lease 且 `/workspace/node_modules/.bin/vite` 存在时启动 Preview；
   无 Lease、活动 Run/Terminal、缺少 Vite 或 Provider 故障必须返回明确状态。
3. 在 iframe 加载真实 HTML/JS/CSS，保持 Preview 运行后执行 Pi 修改同一 Project，
   手动 Reload 必须看到新内容。
4. Preview 运行期间连接 Terminal，验证二者复用同一 `/workspace`；整沙箱 Stop 必须
   返回 `project.busy`。
5. 显式停止 Preview，确认 D1 临时行删除、旧内容 capability 失效，并在之后成功停止
   沙箱。
6. 检查桌面/移动布局、浏览器控制台、响应头和 DOM，不能出现 Provider host、
   sandbox ID、内部端口、traffic token 或 Key。

受控 Changes 另按以下顺序验收：

1. 使用显式安装 Git/Bash/coreutils 的当前不可变组合模板创建新沙箱。
2. 在同一 repository 制造 staged rename + unstaged modification、普通修改、untracked、
   binary 和超大 diff，确认列表与两段详情语义准确、超量明确 `truncated`。
3. 活动 Terminal/Run 时必须显示或返回 `project.busy`；非 Git repository 是明确空态。
4. 添加危险 `filter.*`/include/fsmonitor 等本地配置时请求必须拒绝，并确认配置中的程序
   没有执行；清理配置后恢复。
5. 列表和详情响应必须为 `Cache-Control: private, no-store`，公开 JSON/DOM 不包含
   Provider、sandbox ID、内部端口、命令 stderr 或 Key。
6. `390x844` 通过页头入口打开 Project Inspector 抽屉并访问 Changes；桌面保持三栏。

## 7. Preview 通过条件

- 私有访问和服务端 Run 开关均在真实 Worker 生效。
- 典型 Pi Run、取消、deadline、空闲 TTL 和沙箱停止均通过。
- Gemini Key 只在 Worker，E2B Key 只在 Worker 的 Sandbox Adapter。
- D1 中只出现产品状态和聚合 usage，不出现 Provider Key、raw transcript 或 Project 文件。
- Cloudflare Workflow 免费层的真实限制有实测结论。
- `GOOSE_RUNTIME_MODE=spike` 时只有显式受控 API 可以执行 Goose，公开 capabilities 和 UI 仍保持 Pi-only。
- Project Preview 只运行固定 `vite-v1`，内容只走同源 GET/HEAD capability；Run/Terminal
  并行、整沙箱 Stop 互斥、显式停止和 expiry/idle cleanup 均收敛。
- Changes 只读取当前 Git working tree/index；固定命令、危险配置拒绝、输出上限、
  no-store、公开响应脱敏和移动端抽屉均通过。

完成以上条件后，D2/D3 对应纵切才算通过完整远程环境验收。只读 Files 已使用真实 E2B Lease 验证目录、文本、停止状态和陈旧缓存清理。Terminal 已应用 `0004_terminal_sessions.sql` 并验证同源 WebSocket、真实 `/workspace` PTY、Run/Files/Stop 互斥、显式关闭、断线关闭和 Terminal/Pi Run 文件连续性；30 分钟 durable expiry 由测试覆盖，本轮没有为了验收等待完整时长。Project Preview 已应用 `0005_preview_sessions.sql` 并按上述步骤通过。Changes 不新增迁移，已按上述步骤通过。

当前已完成 owner 注册、Project 创建、Pi/Goose 同一沙箱文件复用、包含工具调用与多次 Gemini 请求的成功 Run、长任务取消，以及临时 8 秒 wall-clock 配置下的 `timed_out` 收敛。取消和超时均没有 assistant Message，后续 Run 仍能读取原文件。临时 8 秒空闲 TTL 已验证 `detached=true, stopped=true`，正式值恢复为 600 秒；手动 Stop UI 也已独立通过。Project Preview 已验证 V1 页面、运行中 Pi 修改后的 V2 Reload、Terminal 并行、Stop 冲突、显式关闭和独立 expiry Workflow smoke。Changes 已验证当前 Git status/diff、安全拒绝、截断和桌面/移动端。最终 Preview/Terminal 临时行均清空，手动 Stop 让 D1 Lease 变为 `stopped` 并清空 Provider 引用，Project 文件按 V1 设计允许丢失。

Worker binding 与 Workflow 版本可能短暂不同步。涉及 wall clock 或 TTL 的部署，必须等待 Workflow 最新版本传播，并在实例详情确认实际 sleep/timeout 后再记录结论。
