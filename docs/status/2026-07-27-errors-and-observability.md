# 2026-07-27 错误语义与结构化日志

> 状态：代码与本地迁移已完成；尚未应用远程 D1 migration，也未部署新版本

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
`0007_agent_run_failure_codes.sql`。真实 E2B/Gemini E2E 仍保持 opt-in，本阶段没有消耗
外部沙箱或模型资源。

## 尚未执行

- 未修改 Cloudflare trace sampling 或远程 observability 配置。
- 未接入 Sentry 或任何新的环境变量。
- 未对远程 Preview D1 应用 `0007`。
- 未执行 `wrangler deploy` 或 Hosted E2E。

这些远程动作需要在代码提交后单独批准和执行。
