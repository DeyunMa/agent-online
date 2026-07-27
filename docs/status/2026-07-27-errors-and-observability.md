# 2026-07-27 错误语义与结构化日志

> 状态：代码、本地/远程 D1 migration、Preview 部署与 Hosted E2E 均已完成

## 本阶段范围

本阶段只实现非功能基础设施，不新增产品能力，也不接入 Sentry、OTel、R2 或其他外部
服务：

- 统一普通产品 API 错误码、HTTP status、retryable 和 response renderer；
- 用稳定 `AgentRun.failureCode` 替代产品层自由失败文本；
- 增加 D1 `failure_code` 和 status 组合 trigger；
- 用 `requestId` 关联单次请求、用现有 `runId` 关联完整 AgentRun；
- 建立固定 diagnostic catalog、事件 schema 和结构化 console adapter；
- 接入 Run 创建/执行/取消/清理、ModelGateway、Preview 和未捕获请求；
- 更新客户端本地化、架构门禁和权威文档。

## 代码位置

| 位置 | 职责 |
| --- | --- |
| `src/shared/error-codes.ts` | public error 与 Run failure code。 |
| `src/server/http/api-errors.ts` | 唯一普通 JSON error renderer。 |
| `src/observability/contract.ts` | diagnostic code、event、stage 和 reporter 接口。 |
| `src/server/observability/structured-reporter.ts` | 无外部依赖的结构化 console adapter。 |
| `migrations/0007_agent_run_failure_codes.sql` | failure code 列、旧数据归一化和 D1 trigger。 |

## 关联规则

```text
HTTP / WebSocket invocation -> requestId
AgentRun full lifecycle      -> runId
Terminal activity           -> terminalSessionId
Preview activity            -> previewSessionId
```

结构化日志不包含 prompt、消息/Agent 输出、文件内容或路径、Provider 引用、capability、
Key、原始异常 message/stack。D1 只保存稳定 Run 终态和 failure code，不保存日志事件。

## 协议变化

普通产品 API 从旧的：

```json
{ "error": "project_busy", "requestId": "..." }
```

变为：

```json
{
  "error": {
    "code": "project.busy",
    "retryable": true
  },
  "requestId": "..."
}
```

`AgentRunResponse.failureReason` 改为稳定的 `failureCode`。Better Auth、Terminal
WebSocket、Preview 内容代理和 ModelGateway wire protocol 不随普通 API 一起改形状。

## 验证

完整 `pnpm check` 已通过：

- import boundary：130 个源文件；
- source/build artifact secret scan：通过；
- Biome lint/format 与 TypeScript：通过；
- Node unit/API：217 passed，1 个外部 E2E skipped；
- Workers runtime D1 migration/trigger：6 passed；
- production Worker/React build：通过；
- Playwright Chromium 核心流程：1 passed。

`pnpm wrangler d1 migrations apply DB --local` 已实际应用
`0007_agent_run_failure_codes.sql`。代码提交 `3480a48` 推送后，远程 Preview 也按
“旧代码锁定、九项预检、迁移、新代码锁定 smoke、解锁”的维护窗口完成发布。

## Preview 发布验证

- 迁移前锁定版本：`305c1f6a-238e-46c7-85e6-532d05032f54`。
- 新代码锁定版本：`4a6e38dd-0062-4a18-92a3-f6b93f9ceff0`。
- 最终解锁版本：`e42fedb1-e386-4427-b283-2ffda2318a9a`。
- 远程 D1 已应用 `0007`，迁移后非法 status/failure code 组合计数为 `0`。
- 锁定 smoke 验证登录、Project/Run 列表、旧 Run `failureCode`、统一错误体以及
  header/body `requestId` 一致。
- Hosted Preview E2E 通过真实 Pi/Gemini Run、usage、Files、取消、刷新恢复、响应脱敏
  和沙箱停止；结束后九项远程预检再次全部为 `0`。
- Cloudflare tail 实际收到受控 `model_gateway.request_failed` 结构化事件，未出现请求
  正文、Key 或 Provider 标识。

本次没有修改 Cloudflare trace sampling，没有接入 Sentry，也没有增加环境变量或外部
观测依赖。
