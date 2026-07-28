# 2026-07-28 交付加固

> 状态：代码、当前事实文档、完整本地质量门禁、私有 Preview 部署和 Hosted E2E 已完成
>
> 范围：不新增产品功能，不修改 D1 schema，不新增环境变量或外部依赖

## 1. 结论

在当前私有 allowlist、单 Worker、D1、E2B 和 Pi 公开 Runtime 的产品边界内，已有功能
已经形成闭环：

- 邮箱密码注册/登录、Project 创建和持久化；
- AgentRun 创建、真实执行所有权、状态 SSE、取消、失败、超时和恢复；
- 用户输入、最终可见回复、Run usage 和用户级聚合；
- 现有沙箱上的 Files、Terminal、固定 Vite Preview、只读 Changes 和手动停止；
- Run/Terminal/Preview 互斥、expiry、idle cleanup 和 Provider 引用脱敏；
- 稳定公共错误码、Run failure code、`requestId`/`runId` 关联和结构化诊断。

本轮审计没有发现必须通过新增产品能力才能修复的交付阻塞。Goose 公开选择、公开注册
防滥用、BYOK、计费、R2、团队和文件备份继续保持在当前范围之外。

## 2. 本轮优化

### HTTP 和浏览器边界

- 普通产品 mutation 在鉴权和 JSON 解析前统一校验同源，并限制请求体为 256 KiB。
- 新增稳定公共错误 `request.too_large`，对应 HTTP 413 和客户端中文文案。
- Hono API 增加基线安全响应头；静态 Assets 通过 `public/_headers` 增加 CSP、frame、
  referrer 和 MIME 防护。
- build artifact validator 现在要求 `_headers` 确实进入 `dist/client`，防止配置文件在
  构建或插件升级后静默丢失。

### 外部请求 deadline

- ModelGateway 单次 Gemini POST 使用 120 秒 deadline，覆盖等待响应头和读取响应体。
- deadline 使用 `MODEL_UPSTREAM_TIMEOUT` 诊断码和通用 `504 model_timeout`，不暴露
  上游正文，也不自动重试非幂等模型请求。
- Preview 内容代理单次 E2B fetch 使用 15 秒 deadline。

### 模块和依赖结构

- `model-gateway.ts` 只保留授权、上游编排、用量和错误映射；协议转换与有界流读取拆到
  独立内部模块。
- `E2BSandboxRuntime` 仍是唯一公开 E2B adapter；进程/PTY 会话、Git Changes、Preview、
  shell 和 SDK 类型拆为内部能力模块，主文件从约 1,200 行降到约 430 行。
- 新增 E2B runtime factory。Files、Terminal、Preview 和 Changes 不再为了取得 adapter
  而间接构造完整 RunExecution、D1 repositories 和 capability codec。
- 移除公开 SSE 合同与 UI 中永远不会由服务端发送的 transient output/tool 分支；公开
  流只保留真实的 `run.status` 和 `run.completed`。

### 编译和测试约束

- TypeScript 启用 `exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、
  `noImplicitOverride`、未使用代码检查、大小写一致性和 isolated modules 等规则。
- 新增同源拒绝、请求体超限、安全响应头、ModelGateway fetch/response-body deadline
  和 Preview abort signal 回归测试。

## 3. 验证结果

`pnpm check` 通过：

| 门禁 | 结果 |
| --- | --- |
| import boundary | 139 个 source file 通过 |
| source secret scan | 通过 |
| Biome lint / format | 通过 |
| TypeScript | 严格配置通过 |
| Node unit/API tests | 223 passed，1 个显式外部 E2E skipped |
| Workers/D1 tests | 6 passed |
| production build | Worker 和 React Assets 构建通过 |
| build artifact validation | 凭据扫描和 `dist/client/_headers` 校验通过 |
| Playwright Chromium smoke | 1 passed；登录、Project、取消 Run 和刷新恢复闭环通过 |

### 私有 Preview

- 部署目标：`agent-online-preview`
- URL：`https://agent-online-preview.mdy1145141.workers.dev`
- Cloudflare Version ID：`9e720ed3-b4a1-4d2a-b382-4dcf48489854`
- D1：无待应用 migration；部署前后九项只读发布预检均通过。
- 线上 `/api/health`、公开 capability、API 安全头和 Static Assets CSP 均通过。
- 未登录跨源 mutation 返回 `403 request.forbidden`；超出 256 KiB 的同源 mutation
  返回 `413 request.too_large`。

Hosted E2E 使用真实 React、Hono、Better Auth、D1、Workflow、Gemini、E2B 和 Pi：

1. 基线用例通过：创建 Project、Pi 写文件、最终 Message、真实 usage、Files、第二个
   Run 取消、刷新恢复、沙箱停止和 JSON 响应脱敏。
2. 全能力用例通过：Pi 在一个新沙箱中安装固定 Vite、初始化 Git 并留下可见 Changes；
   浏览器随后完成 Changes/diff、WebSocket Terminal 写文件、Files 回读、Vite Preview
   加载/停止和整沙箱停止。
3. 全能力 Pi Run 记录 151,664 total tokens、28 次模型请求和约 59.5 秒沙箱执行时间；
   这是发布验收成本事实，不是产品配额或计费。
4. 测试完成后 PreviewSession、TerminalSession、非终态 Run、活动 Provider 引用等九项
   预检再次全部为零。

首次基线执行在 Playwright `route.fetch()` 审计层遇到一次连接重置；对应产品 Run
实际成功且沙箱已清理。测试只对幂等 GET/HEAD 增加最多两次网络重试，POST 仍不重放，
随后基线和全能力用例均通过。产品代码无需因此重新部署。

## 4. 仍然接受的限制

- Project/Message 无分页，适合当前个人数据量，不适合无约束公开规模。
- 没有应用级 rate limit、验证码、用户资源预算或 abuse control；因此公开注册仍未
  达到安全开放条件。
- Files/Changes 与外部沙箱文件系统不是事务快照，仍有已记录的尽力一致性和 TOCTOU
  边界。
- Project 文件只有当前沙箱一份；停止、过期或 Provider 故障后允许丢失。
- 默认 `pnpm check` 只覆盖无外部成本的核心控制面；真实
  Terminal/Preview/Changes/Gemini/E2B 由本轮新增的显式 Hosted E2E 覆盖，不进入 CI。
- Sentry/OTel、readiness、source map 校验和不变量告警仍是候选，不是当前交付阻塞。

## 5. 相关文档

- [当前项目架构](../reference/current-architecture.md)
- [HTTP、SSE 与 WebSocket 接口](../reference/http-api.md)
- [平台限制与限制对象](../reference/platform-limits.md)
- [本地开发](../setup/local-development.md)
- [Hosted Preview E2E](../testing/hosted-preview-e2e.md)
- [Hono secure headers](https://hono.dev/docs/middleware/builtin/secure-headers)
- [Hono body limit](https://hono.dev/docs/middleware/builtin/body-limit)
- [Cloudflare Static Assets headers](https://developers.cloudflare.com/workers/static-assets/headers/)
