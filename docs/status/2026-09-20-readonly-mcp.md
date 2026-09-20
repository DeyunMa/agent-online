# Agent Online 只读 MCP 实施记录

状态：已完成实现、本地验证、Preview 部署及官方 SDK 真实 OAuth/MCP 验证。等待用户评估接入体验。

## 目标与授权

为 ChatGPT、Codex 等标准 MCP 客户端提供有业务语义的项目运行分析能力。
用户于 2026-09-20 授权持续完成实现、部署和真实 MCP 连接验证，并要求保留过程与结果。
部署目标为仓库现有私有 Cloudflare Preview；不创建第二个 Worker，不改变沙箱 Provider，
不提交或推送 Git，不删除业务数据。

## 范围与完成条件

- 在现有 Hono / Worker 中提供 Streamable HTTP `/mcp`。
- OAuth 授权码 + PKCE，复用 Better Auth 身份；包含发现、授权、同意、刷新和撤销。
- 首版读取当前授权用户的项目和 Run，提供系统背景、用量汇总、Run 列表和详情。
- 信息覆盖状态、失败分类、模型、运行时间、token、请求数及沙箱执行时长；不等同于账单。
- 显式输出字段白名单，身份与项目归属检查，有界分页和请求体；不提供任意 SQL、shell、
  沙箱操作、用户消息、文件内容、Provider 引用或密钥。
- 将查询服务与 MCP adapter 分离，使用标准协议与稳定工具合同；不为开发阶段引入旧版兼容层。
- 通过仓库完整检查、本地 D1 迁移、协议与认证集成测试，然后发布 Preview。
- 使用真实 MCP 客户端连接已部署入口，发现并调用工具，记录实际返回的安全摘要与拒绝路径。
- 明确区分 SDK 客户端验证与 ChatGPT UI 连接验证，未验证项不宣称完成。

跨用户产品分析需要独立维护者权限，首版不隐式提升当前用户权限。完整 trace、日志搜索和
真实金额没有现成数据源，本次不为这些能力扩大原始内容采集。

## 阶段 1：现状与技术选择

- 开始时 `git status --short` 为空。
- 当前 Better Auth 1.6.25 使用邮箱密码与 Cookie 会话；现有 API 的同源保护必须保留。
- `ProjectReadService` 已支持 owner scope 和游标分页；`UserUsageService` 已合并现存与
  已删除 Project 的最小 usage 归档，当前统计口径是 all-time。
- 选择与现有版本匹配的 `@better-auth/oauth-provider@1.6.25`，避免为 MCP 升级整个认证体系。
- 选择 `@modelcontextprotocol/sdk@1.30.0`，将验证其 Web Standards transport 在 Workers 中运行。
- OAuth 外部协议入口与产品 Cookie API 的请求保护分开；不整体放宽 `/api/*`。

依据：

- [OpenAI MCP 认证要求](https://developers.openai.com/plugins/build/auth)
- [Better Auth 1.6 OAuth Provider](https://better-auth.com/docs/1.6/plugins/oauth-provider)

## 阶段 2：实现与本地验证

已实现：

- `src/server/mcp/`：标准发现、Bearer 校验、无状态 Streamable HTTP、五个工具、显式输入/输出 schema。
- `src/application/project-insights.ts`：owner-scoped 查询的安全投影。
- `0010_mcp_oauth.sql` 和 Drizzle 映射：从已安装 OAuth/JWT 插件 schema 核对新增认证表。
- `/mcp/authorize`：复用登录，展示读取范围，明确 Allow/Deny；不让用户复制凭据进聊天。
- Rate Limiting binding、请求体、分页、输出体积和 all-time 查询预算；异常只返回固定错误。
- `scripts/verify-mcp.mjs`：官方 SDK 标准 OAuth/MCP 探针；令牌仅内存，查询后撤销刷新令牌。
- [ADR-0013](../adr/0013-readonly-product-insights-mcp.md) 和 [接口/接入文档](../reference/mcp-api.md)。

已得到的证据：

- 单元测试：409 passed，1 个真实 E2B opt-in 用例 skipped。
- Workers/D1：27 passed，包含迁移/Drizzle 对齐以及四个 OAuth/MCP 集成场景。
- OAuth/MCP 集成验证了签名、audience、scope、期限、allowlist 变化、请求上限、
  PKCE 换取令牌、授权码不可重放、刷新与撤销、真实归属隔离及归档计量。
- 独立浏览器用例已通过未登录跳转、登录恢复、明确同意和真实 MCP initialize。
- 完整 `pnpm check` 通过，browser smoke 24 passed。最后补充显式 output schema 后，
  静态检查、409 个单元测试、27 个 D1 测试与构建再次通过；OAuth/MCP 四个场景单独复验通过。
- 本地 D1 `0010` 应用成功，16 条 SQL，无业务数据重置。
- `deploy:preview:dry-run` 成功，含两个 rate-limit binding；产物凭据和安全头扫描通过。

实现过程中处理：

- SDK `exactOptionalPropertyTypes` 声明不一致：只在测试客户端连接边界做窄类型断言，
  生产 server 使用省略选项的标准 stateless 模式，未修改依赖源码。
- OAuth 的真实返回字段是 `url`，页面按本地类型和测试实现；不照搬旧示例的 `redirect_uri`。
- 浏览器测试 sign-out 需要 JSON 请求体；修正后验证真正的未登录授权流程。
- 一次重复启动完整检查与仍运行的浏览器服务冲突，第二轮 browser 阶段因 4173 端口占用
  退出；未重启或替换正在运行的服务，按顺序等待并复核结果。
- 首轮真实 SDK 查询、刷新、撤销均成功，但 finally 重复撤销已撤销令牌导致清理误报；
  脚本记录成功撤销状态，避免重复请求。第二轮完整远程探针退出码为 0。

## 阶段 3：部署与远程验证

目标：现有 `agent-online-preview` Worker 与 `agent-online-preview-db`，固定仓库 Preview Account。
远程发布前版本：`6c188619-fb0b-42b4-bd0b-ce0f4fb67aa0`。
远程只读 preflight 九项检查通过。用户已在验证浏览器登录，后续使用该登录态授权 SDK 客户端。

本次迁移纯 additive，无现有 Run trigger 或数据合同切换；先应用 `0010` 再部署 Worker，
不修改 Run 开关、不创建沙箱、不调用模型。回退保留认证表，恢复发布前 Worker。

2026-09-20 实际执行：

1. 固定 Preview Account、移除继承的 API token 环境覆盖，远程应用仅 `0010_mcp_oauth.sql`，
   16 条 SQL 成功，未重置业务数据。
2. `pnpm deploy:preview` 完成账号/config guard、Preview 构建、产物扫描、Sentry source maps
   上传和 Worker 发布。版本为 `6738882e-9fd6-4f9d-b9e2-85968faa0e9d`。
3. 未认证 `/mcp` 返回 401 和标准 WWW-Authenticate；资源与授权发现均返回 200。
4. 官方 `@modelcontextprotocol/sdk` 客户端动态注册，浏览器使用已有登录态明确同意，
   完成 PKCE 换取令牌、MCP initialize、tools/list，以及五个工具的实际成功调用。
5. 刷新后再次读取成功；撤销后 refresh 被拒绝；不存在的 Project/Run 返回工具错误。
   两轮探针均已撤销自己的刷新令牌，认证 client/consent 记录保留，令牌未落盘。
6. 登录态产品 `/api/usage` 返回 200，六个总量字段与 MCP 返回逐项一致。

发布构建存在单个生成 chunk 无 source-map reference 的 Sentry 警告，上传总体成功；
这不影响 MCP 验证，但不宣称该 chunk 的错误栈一定能还原。

真实读取的安全摘要（不是账单）：

| 指标 | 结果 |
| --- | --- |
| Server | `agent-online-insights` / `1.0.0` |
| 当前项目 / 含归档的用量项目 | 2 / 6 |
| Run 数 | 16 |
| 输入 / 输出 / 总 token | 123439 / 6469 / 138806 |
| 已记录模型请求 | 50 |
| 已记录 Run 沙箱执行时长 | 273480 ms |
| 抽查 Run | succeeded，gemini-3.6-flash，4499 tokens，2 requests，13761 ms |

token 数直接使用现有计量字段，不将 input + output 重新计算成 total。
验证没有启动 Agent、沙箱或模型调用，没有读取消息正文、文件或 Provider 引用。

## 最终验收

- 实现、部署、真实客户端连接和业务数据读取均已完成；未提交或推送 Git。
- MCP 地址：`https://agent-online-preview.mdy1145141.workers.dev/mcp`。
- 兼容性证据是官方 SDK 的标准 Streamable HTTP + OAuth/DCR/PKCE 全链路，
  不代表已经逐一验证 ChatGPT、Claude、Codex 的客户端 UI，也不提供旧版 SSE/CIMD。
- 用户下一步可按 [接入文档](../reference/mcp-api.md) 在目标客户端连接，并评估信息是否足够。
- 当前范围仍为授权用户自己的数据。跨用户维护者分析、原始 trace 与账单不在本次范围。

## 第二轮：最佳实践整改

用户要求修复评审中列出的四项问题并部署。整改保留原五个只读工具和单 Worker 架构：

- 有效令牌缺少 scope 返回 403 insufficient_scope，失效令牌仍返回 401。
- MCP 资源发现/challenge 只声明 insights:read；offline_access 留在授权服务器，验证客户端显式申请。
- Better Auth/OAuth Provider/CIMD 同步升级至 1.7.5，使用官方 CIMD 插件而非自建 OAuth 逻辑。
- Workers 的 Node DNS lookup 不可用，Request.redirect:error 也不支持。采用明确受信任的
  chatgpt.com 官方元数据路径与 JWKS 地址；manual 接收后拒绝重定向，不向任意主机抓取。
  其他客户端继续使用 DCR；CIMD 新来源须审阅网络信任策略后增加，不宣称任意主机兼容。
- 账号菜单增加 Connected apps，分页展示本人授权，确认后按 owner/client 原子删除 consent
  与 token；不删除共享客户端或其他用户授权。JWT 最长五分钟到期的边界保持可见。
- 0011 为认证增量迁移（33 条 SQL）：增加资源/发现/轮换字段、资源表及重放记录，保留账号、
  原业务数据和现有授权；原 type/public 仅保留物理列，不增加旧代码兼容逻辑。
- 本地 0011 迁移通过；远程只读 preflight 九项通过。
- 新测试覆盖资源 scope、CIMD 公共与 private_key_jwt 客户端、可信 JWKS 抓取、网络边界、
  跨用户撤销隔离、CSRF 拒绝、浏览器确认撤销与撤销后的刷新失败。
- 第一轮完整检查中 23/24 浏览器用例通过；新增菜单改变初始键盘焦点，调整菜单顺序后重新回归。

第二轮最终验收：

- `pnpm check` 退出 0：411 个单元测试、30 个 Workers/D1 测试、24 个浏览器用例通过；
  1 个真实 E2B opt-in 单元入口仍按策略跳过。静态、类型、构建和凭据扫描通过。
- 远程仅应用 0011，Wrangler 报告 35 条命令成功（含远程迁移执行附加命令），无业务数据重置。
- `pnpm deploy:preview` 成功；版本 `b0f68d0b-9b26-482f-b994-979220e0ade0`，
  回退基线为本轮前的 `6738882e-9fd6-4f9d-b9e2-85968faa0e9d`；回退时保留增量认证表。
- 线上 `/mcp` 未认证返回 401，challenge 仅 insights:read；资源发现同样仅 insights:read，
  授权发现公布 CIMD=true、offline_access 与 private_key_jwt。
- 真实 SDK OAuth/PKCE 全链路退出 0，五个工具均成功，刷新成功且撤销后刷新被拒绝；
  真实总量保持 16 Runs、138806 tokens、50 requests、273480 ms。
- 浏览器实际打开 Connected apps，确认撤销本轮验证连接；该连接从列表消失，之前的连接保留。
- 从已登录浏览器发起 ChatGPT 官方 CIMD URL 授权探针，Worker 实际抓取官方元数据，返回
  200 和正确 consent 页面地址；未代替用户同意 ChatGPT 连接。private_key_jwt 的签名
  换令牌链路由 Workers/D1 测试验证，不宣称完成真实 ChatGPT UI 客户端验收。
- 使用 local-friction-log 记录 Workers redirect 模式、Node DNS 不兼容和 OAuth 1.7.5
  OpenAPI 类型声明问题，见 `.agents/friction-log/20260920164800-auth-cimd-workers/friction.md`。
- 未提交或推送 Git，未启动 Agent/沙箱或调用模型。


## 独立复审后处理

- CIMD 每请求重建插件属于项目集成缺陷，改为按 D1 binding 与 issuer 复用。
  新增跨请求 freshness、并发合并、每分钟获取预算及环境隔离测试。预算仅作用于单 isolate。
- 撤销竞态已确定性复现为 Better Auth 1.7.5 上游轮换写入缺陷：本项目撤销和原生
  revoke family invalidation 都无法阻止正在等待 INSERT 的刷新后继。npm latest 仍为 1.7.5。
  按用户明确的上游例外保持 open；没有 patch 依赖，也没有对外提交报告。
- 两个 `it.fails` 记录未修复的安全断言；移除 `.fails` 实跑确认均在最终续期断言失败
  （期望 400，实际 200），前序撤销和 D1 无令牌检查均通过。不能将它们计为问题已解决。
- Connected apps 页面及当前 MCP 合同已更正无条件断开保证。

验证结果：`pnpm check` 退出 0，412 个单元测试通过、1 个 opt-in 跳过；
32 个 Workers/D1 测试通过，另有 2 个上述已知预期失败；24 个浏览器测试通过。
最后授权页措辞调整后 TypeScript、Biome 和 Preview 构建再次通过。
本地 D1 无待应用迁移，远程只读 preflight 9 项通过，本轮没有新增迁移或修改 Secret。

Preview 已发布版本 `7e8ac92c-7be4-4d62-bf00-96749085f9ba`，上一个版本为
`b0f68d0b-9b26-482f-b994-979220e0ade0`。独立子智能体复核认可 P2 修复与 P1 上游归因；
本次未提交或 push Git。上游缺陷仍开放，不能宣称全部安全问题已修复。
