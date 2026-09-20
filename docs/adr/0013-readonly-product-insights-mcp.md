# ADR-0013：同 Worker 的只读产品分析 MCP

- 日期：2026-09-20
- 状态：接受（用户授权实现、部署与验证）

## 动机

让外部 MCP 客户端结合代码与真实产品状态分析 Agent Online，保持事实查询与模型判断分离。
信息覆盖需要足够完整，但不能通过通用 SQL、shell 或跨用户权限扩大访问面。

## 决策

1. 在现有 Worker/Hono 中增加 `/mcp`，不增加部署单元、Agent 框架或模型调用。
2. 官方 TypeScript MCP SDK 1.30 的 Web Standards Streamable HTTP transport，逐请求
   创建无状态 server/transport，使用 JSON 响应；不建立长期 MCP session 或旧 SSE 双端点。
3. 使用 Better Auth 1.7.5 对应 OAuth Provider + JWT + CIMD 插件。复用现有邮箱密码登录和
   allowlist，采用标准授权码 + S256 PKCE、用户显式同意、CIMD/DCR、发现、刷新与撤销。
4. Resource 为固定部署 Origin 的 `/mcp`；issuer 为同 Origin 的 `/api/auth`。认证逐次
   验证签名、issuer、audience、期限、subject 和 `insights:read`，再查当前用户及 allowlist。
   Cookie 不能直接访问 MCP；MCP Bearer 不能冒充产品 Cookie。
5. `insights:read` 只允许当前用户的产品分析。`offline_access` 允许刷新，不增加业务权限。
   禁用 client_credentials，不允许模型通过参数指定身份。跨用户维护者分析需要另行授权和合同。
6. JWT access token 五分钟到期。撤销 refresh token 阻止后续签发；已签发 JWT 在到期前
   仍有效，最长五分钟。移出 allowlist 或删除用户立即阻断 MCP 查询。
7. `ProjectInsightsService` 提供显式字段投影，复用 ProjectReadService 和 UserUsageService。
   MCP 层不持有业务写能力。五个工具覆盖系统语义、项目、all-time 用量和 Run 详情。
8. OAuth 表属于认证状态，新增迁移不改动业务数据，不采集消息、trace 或终端历史。

## 边界与资源预算

- 请求体 64 KiB，单次工具文本数据最多 192 KiB（JSON-RPC 会同时包含 text 和 structuredContent）。
- 项目/Run 游标页 50 条；用量项目分组页 50 条。响应包含 schemaVersion、observedAt、source。
- 当前 all-time 聚合最多 100000 个现存/归档 Run；先做有界计数再复用同一聚合口径。
  超限报 query.budget_exceeded，不返回抽样总量。更大规模需要独立聚合设计。
- Cloudflare Rate Limiting binding 限制 MCP 每 IP、每用户各 60 次/分钟；OAuth 普通请求
  每 IP 60 次/分钟、DCR 每 IP 10 次/分钟。这是分布式近似保护，不是全局精确配额。
- 有 Origin 的 MCP 请求只允许部署自身 Origin；无 Origin 的标准服务端 MCP 客户端允许。
  产品 `/api/*` 的既有同源规则不变，OAuth 保留协议与库自带的 CSRF 校验。
- 不返回 Provider 引用、私有进程、消息 ID、原始异常、模型准入内部字段、密钥或认证记录。
  项目标题是用户输入，作为数据处理。usage 是记录的消耗，不是真实费用。
- 本次不增加业务审计表。使用已有脱敏诊断；Better Auth 原始 logger 关闭，避免认证内容日志。

## 兼容策略

面向标准 MCP 客户端，不使用 ChatGPT 专有 UI 元数据。新增工具或可选字段可增量扩展；
变更工具参数、字段语义或权限时提升合同版本并更新客户端文档与测试。当前开发阶段不保留
过时接口的兼容层。支持官方插件 CIMD 与既有 DCR 客户端，旧 HTTP+SSE 不支持。
Workers 无可移植 DNS pinning Fetch，因此 CIMD 网络信任限制为 ChatGPT/Codex 官方
chatgpt.com 元数据及密钥路径，而非自制 DNS 预检后任意 fetch；新增来源须明确审阅。
插件负责元数据一致性、体积、超时和 public/private-key 客户端验证；网络层不跟随重定向。
资源只声明 insights:read；权限不足使用 403 insufficient_scope；offline_access 由客户端选择。
账号连接页提供显式确认的撤销入口，按当前用户及客户端原子删除授权和续期能力。

## 验证与后果

真实 Workers D1 测试覆盖 OAuth、PKCE、令牌边界、owner isolation、归档统计、工具协议与脱敏。
浏览器测试覆盖登录后的授权恢复与明确同意。远程验证使用官方 SDK 客户端完成标准发现和
授权，逐个调用工具；SDK 验证与 ChatGPT 界面验收分别记录。

新增 OAuth 客户端、consent、token 与 JWKS 认证表以及两个 Rate Limiting binding。
回退 Worker 时保留 additive 表，不删除已存在数据。没有引入新的用户角色或模型权限。

依据：[OpenAI 认证文档](https://developers.openai.com/plugins/build/auth)、
[Better Auth CIMD](https://better-auth.com/docs/plugins/cimd)、
[MCP 2026-07-28 授权](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)。
