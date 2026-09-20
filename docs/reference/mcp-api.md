# 只读 MCP 接口

校准日期：2026-09-20。决策见 [ADR-0013](../adr/0013-readonly-product-insights-mcp.md)。
部署与实际验收见 [实施记录](../status/2026-09-20-readonly-mcp.md)。

## 连接

- Streamable HTTP：`https://agent-online-preview.mdy1145141.workers.dev/mcp`
- 资源发现：`/.well-known/oauth-protected-resource/mcp`，根发现路径也可用。
- 授权发现：`/.well-known/oauth-authorization-server/api/auth`。
- issuer：同 Origin 的 `/api/auth`；resource：同 Origin 的 `/mcp`，精确校验。
- OAuth 授权码 + PKCE S256；支持 CIMD、动态客户端注册（DCR）、刷新、撤销。
- CIMD 当前批准 `https://chatgpt.com/oauth/.../client.json`（含 ChatGPT/Codex）以及官方
  `/oauth/jwks.json` 密钥地址；拒绝重定向、其他域名和任意元数据 URL。其他客户端使用 DCR。
  新增 CIMD 来源需要审阅服务端网络信任策略，不自动信任 URL 所有者。
- 资源 scope：`insights:read`。`offline_access` 仅由授权服务器公布，客户端需要续期时显式请求；
  不出现在 MCP 的 WWW-Authenticate 或资源发现中。
- 授权同意页：`/mcp/authorize`；先使用既有受邀账号登录，再明确同意客户端读取。
- MCP 不接受 Cookie 登录替代 Bearer，也不接受平台管理凭据。令牌不要粘贴到聊天。

## 工具合同 v1

| 工具 | 参数 | 返回事实 |
| --- | --- | --- |
| `get_system_context` | 无 | 架构、领域术语、指标单位、数据缺失及分页口径 |
| `list_projects` | 可选 `cursor: {at,id}` | 当前用户的 Project ID、标题、创建/更新时间、默认 Runtime、当前沙箱状态 |
| `get_usage_summary` | 可选 `projectOffset`，默认 0 | all-time 总量、Runtime 分组、最多 50 个项目分组，含已删除 Project 归档 |
| `list_runs` | `projectId`，可选 `cursor` | 当前 Project 的 Run 状态、稳定失败码、模型、时间及聚合用量 |
| `get_run_summary` | `projectId`、`runId` | 一次 Run 的同一组安全字段 |

成功结果含 `schemaVersion: 1`、`observedAt`（UTC 读取时间）、`source`，并同时返回
`structuredContent` 和 JSON text。时间是 UTC ISO 8601；token 单位为 token，
`sandboxDurationMs` 为毫秒。`observedAt` 不是数据库事务快照时间。

Project/Run 列表按时间及 ID 倒序，每页 50 条；原样传递 nextCursor，null 表示结束。
用量分组传递 nextProjectOffset，null 表示结束；总量每页均覆盖全量，不要跨页重复相加。
数据在执行过程中可能变化，用量 offset 分页不提供跨请求快照一致性。

用量包含已记录的非终态、失败、取消及超时 Run，不含 Terminal/Preview 的长期消耗；
归档 Run 不保留失败详情，所以 Run 详情只能查现存 Project。API 没有日期筛选或货币金额。

## 限制和错误

参数长度和游标格式由 Zod 校验。MCP 方法只允许受认证的 POST；GET SSE 和 DELETE session
返回 405。请求体 64 KiB，工具 text 最多 192 KiB，全量用量扫描预算 100000 个 Run。

- `401` + WWW-Authenticate：令牌缺失、无效、过期或用户不再允许访问。
- `403 insufficient_scope` + WWW-Authenticate：有效令牌缺少 `insights:read`。
- `403 origin.forbidden`：带入不受信任 Origin。
- `413 request.too_large`：请求体超限。
- `429 rate_limited` + Retry-After：请求频率限制；MCP 每 IP/用户各 60 次/分钟。
- `503 mcp.unavailable`：限流 binding 未配置，拒绝服务而非静默开放。
- 工具 `isError`：`resource.not_found`（不存在/越权同形）、`query.unavailable`、
  `query.budget_exceeded` 或 `result.too_large`；不透传底层原始异常。

## 接入 ChatGPT

在支持自定义 MCP 的账号/工作区中，开启对应开发者功能，添加上述 HTTPS MCP 地址，
选择 OAuth，客户端可通过 CIMD 或 DCR 识别，完成 Agent Online 登录与同意，检查五个工具。
具体菜单名称与账号可用性以 ChatGPT 当前界面为准。

建议先问：“读取系统背景和我的用量汇总，解释统计口径，再列出当前项目和近期失败 Run。
请区分事实、推断及当前没有采集的数据，不把 token 换算成实际账单。”

代码与 PR 可由独立代码连接提供；本 MCP 不读取本地仓库或 GitHub。

## 可重复验证

```sh
rtk proxy node scripts/verify-mcp.mjs --url https://agent-online-preview.mdy1145141.workers.dev/mcp
```

脚本打印授权 URL；在浏览器完成登录同意后，回调至随机本地 loopback 端口。官方 SDK
执行发现、工具调用、刷新、撤销和拒绝路径。令牌只留在进程内存，不打印或写文件。
脚本仅写必要认证记录，不启动 Run 或沙箱，不修改 Project。

单个 access token 的 TTL 为五分钟；移出 allowlist 即刻阻断查询。
注意下文的上游并发撤销限制，不能把 TTL 理解为所有连接都保证五分钟内失效。
脚本退出前尽力撤销自己的 refresh token。DCR 客户端和 consent 是认证记录，会留存。

## 已连接应用与撤销

账号菜单的 **Connected apps**（`/settings/connections`）分页展示自己的已授权应用及 client ID。
点击 **Revoke access** 后明确确认，会在同一个 D1 batch 中删除该用户对此客户端的
consent、refresh token 和已存储的 access token；不会删除共享客户端或其他用户的授权。
已签发的 JWT access token 仍按五分钟 TTL 到期。顺序撤销后再次连接需要重新授权。

**已确认的上游限制（Better Auth 1.7.5）**：刷新轮换将旧令牌 CAS 失效和新令牌 INSERT
分开执行；若撤销发生在两者之间，后续 INSERT 仍能写入可继续续期的新令牌。
本项目接口与上游原生 revoke 的 family invalidation 均已在真实本地 D1 确定性复现。
因此并发场景不能保证断开后五分钟内彻底失效。测试中两个明确标注的 `it.fails`
记录此未修复缺陷，不代表安全断言通过；按用户的上游缺陷例外保留，未修改依赖内部实现。

CIMD 插件按 D1 binding 对象和 issuer 复用，缓存、并发合并与获取预算跨请求生效。
预算为每个 Worker isolate 的最多 4 个并发获取、每分钟 30 次，不是跨所有 isolate 的
全局限流。不同数据库或 issuer 不共享解析与持久化中的请求。

管理 API 为 Cookie 认证的 `GET /api/mcp/connections?cursor=...` 与同源
`POST /api/mcp/connections/:id/revoke`，不属于 MCP 工具，也不接受 MCP Bearer 代替登录。

## 部署和回退

本地完整检查：`rtk proxy pnpm check`。本地迁移：
`rtk proxy pnpm wrangler d1 migrations apply DB --local`。
发布前按现有 Account guard 做只读 preflight；0010 增加 OAuth 表，0011 增量升级
Better Auth 1.7.5 所需认证字段与资源表，保留现有账号和业务数据。可先应用迁移
再部署 Worker，不需要修改 Run trigger 或清空业务表。Preview 的两个 rate-limit binding
及 `/mcp`、`/.well-known/*` Worker 路由必须一起发布。

回退到发布前 Worker 版本即可关闭新入口；保留 0010 表与认证记录，不执行 DROP TABLE。
新客户端应重新检查连接。旧 access token 五分钟内过期，未部署 MCP 的版本不会消费它。
