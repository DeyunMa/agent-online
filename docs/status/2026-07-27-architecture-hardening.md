# 2026-07-27 架构与工程门禁加固

> 范围：不新增产品功能，只修正现有合同的原子性、边界、可维护性和自动验收能力。
> 远程状态：本轮没有部署、修改远程 D1、创建资源或运行付费 E2B/Gemini E2E。
> 后续状态：同日已按本记录规划完成私有 Preview 发布，见
> [Preview 发布与 Hosted E2E](./2026-07-27-preview-release.md)。

## 1. 目标

本轮处理此前代码与文档审计中确认的结构性问题：

- 成功 Run 的终态、usage、最终 assistant Message 和 Project touch 分步写入，取消竞态可能产生不一致。
- D1 主要依赖应用层校验，缺少跨表归属和状态迁移的数据库约束。
- Hono Project 路由承担过多编排，公开 DTO 依赖服务端内部合同。
- ModelGateway、SSE 轮询和错误日志缺少统一的资源与脱敏边界。
- fake 模式、真实 D1 迁移、浏览器核心流程和源码凭据没有进入统一质量门禁。
- 当前事实、历史验收与下一次远程部署步骤容易混淆。

## 2. 完成的代码加固

### AgentRun 与 D1

- `AgentRunRepository.completeSucceeded` 使用一个 D1 batch 完成：
  - `running -> succeeded` 条件迁移；
  - 最终 usage、sandbox duration 和完成时间写入；
  - 可选最终 assistant Message 写入；
  - Project `updated_at` 更新。
- 取消在成功 batch 前获胜时，成功写入返回空值且不产生 assistant Message。
- `0006_integrity_guards.sql` 增加 Run 归属、Run 状态机、Message/Run 关联和
  Terminal/Preview Lease 一致性 trigger。
- 新增 Workers 环境中的真实 D1 migration 测试，覆盖全部迁移、原子成功、取消竞态、
  跨 owner 回滚和非法状态迁移。

### 模块与公开合同

- 将浏览器需要的状态字面量下沉到 `src/shared/protocol.ts`，公共 API 不再反向导入
  `domain`、`runtime` 或 `agent` 内部模块。
- 将 Project 聚合路由拆成 Project、Files 和 AgentRun 路由模块；Hono 继续只负责鉴权、
  校验、用例调用与响应映射。
- Message 响应改为显式公开字段映射，不返回内部 `projectId`。
- 删除未使用的 Repository 方法和 `ServerServices` 配置字段，缩小无效合同。
- 将 1619 行 D1 聚合文件按 Project/Message、Lease、Run、Terminal、Preview 和 Usage
  adapter 拆分，保留 9 行兼容导出入口；测试按同一边界拆分并共享 D1 test double。
- 将 Workflow 分发与 expiry/idle 调度从 `services.ts` 移到
  `run-execution-dispatcher.ts`，服务装配文件从 484 行降到约 285 行。
- 将认证、Project 列表和创建页面移出 `router.tsx`，路由定义文件从 526 行降到约
  113 行；`ProjectConsole` 保留为单个页面协调器，不为减少行数拆出浅转发层。

### 资源与安全边界

- ModelGateway 限制请求体、成功响应和错误诊断读取量，并拒绝无声明长度的超量流。
- 全局异常日志只记录 request ID 和错误类名，不记录原始错误消息。
- AgentRun SSE 在浏览器断开时停止轮询，并降低状态查询频率。
- 源码与构建产物都执行内容型 Secret 扫描；命中时只报告文件，不输出凭据内容。

## 3. 统一质量门禁

`pnpm check` 现在按顺序执行：

1. import boundary 检查；
2. 源码凭据扫描；
3. Biome lint 与 format check；
4. TypeScript typecheck；
5. Node 单元/API 测试；
6. Workers 环境真实 D1 migration/trigger 测试；
7. production build 与构建产物凭据扫描；
8. 隔离 fake D1 的 Playwright 核心浏览器 smoke。

浏览器 smoke 只验证现有注册、Project 创建、fake Run 取消和刷新恢复，不启用 E2B、
Gemini、Terminal、Preview 或 Changes，也不读取开发者的 `.dev.vars`。

另增加显式 opt-in 的 Hosted Preview Playwright 配置，覆盖真实登录、Pi Run、最终
Message/usage、Files、取消、停止和公开 JSON 脱敏。该测试只在部署并重新打开 Run
之后执行，不进入默认门禁。

## 4. 部署和数据状态

- 本地 migration 集合当前为 `0001` 至 `0006`。
- Cloudflare Preview 仍停留在 `0005` 和上一部署版本。
- 下一次远程部署必须在明确授权后执行：先把 `RUNS_ENABLED` 关闭并部署当前新代码，
  等待旧 Run/Workflow 与 Terminal/Preview 活动收敛，通过只读完整性预检后再应用
  `0006`；完成锁定 smoke 后才重新打开真实 Run。旧 Worker 不能在 `0006` 的
  assistant Message trigger 下继续完成执行。
- 本轮没有为旧本地数据增加兼容逻辑；开发数据仍可直接重建。
- 顶层 production 配置仍是占位状态，通用 deploy 已增加阻断；Preview Account 在
  Wrangler 配置中固定，环境变量冲突也会在远程命令前失败。

## 5. 验收记录

2026-07-27 最终执行 `pnpm check`，完整通过：

- import boundary：检查 124 个源码文件，无跨层违规。
- 源码 Secret 扫描、Biome lint/format 和 TypeScript typecheck：通过。
- Node 单元/API 测试：39 个文件通过、1 个显式 opt-in E2E 文件跳过；
  196 个测试通过、1 个跳过。
- Workers D1 测试：1 个文件、5 个测试通过，实际应用 `0001` 至 `0006`。
- production build 与构建产物 Secret 扫描：通过。
- Playwright Chromium smoke：1 个测试通过，覆盖注册、Project 创建、fake Run 取消和
  刷新恢复。
- Preview 配置与 Account pin 校验通过；production guard 按预期拒绝当前占位配置；
  独立本地 Preview D1 的九项发布预检全部为零。
- Hosted Preview E2E 配置已通过 Playwright `--list` 和 TypeScript 校验，但本轮没有
  远程部署，因此没有执行会产生真实 E2B/Gemini 请求的发布后测试。

跳过项是需要真实 E2B/Gemini 的付费链路，不影响本轮无外部成本的架构加固验收。

## 6. 保留限制

- 真实 E2B/Gemini E2E 仍是显式 opt-in，不属于每次提交的默认门禁。
- Files/Changes 的 Lease 检查和 Provider 读取是尽力一致，不宣称严格并发原子性。
- D1 与外部沙箱在故障中仍可能短暂漂移；按
  [协调状态恢复](../operations/coordination-recovery.md)诊断，不自动删除远程资源。
- 本轮不增加 rate limit、公开注册、配额、计费、BYOK、管理员、R2 或新 Agent Runtime。
