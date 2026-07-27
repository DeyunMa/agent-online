# 2026-07-27 Preview 发布与 Hosted E2E

> 状态：架构加固代码、D1 `0006_integrity_guards.sql`、最终 Preview 部署和真实 Hosted
> Preview E2E 已完成。当前仍是 allowlist 私有 Preview，不是公开生产环境。
> 关联：[架构加固](./2026-07-27-architecture-hardening.md) ·
> [部署流程](../setup/preview-deployment.md) ·
> [资源台账](../setup/cloudflare-preview-resources.md) ·
> [Hosted E2E](../testing/hosted-preview-e2e.md)

## 1. 发布范围

本次发布不新增产品功能，交付的是已完成审计的架构与工程加固：

- AgentRun 成功终态、usage、最终 assistant Message 和 Project touch 的 D1 原子写入；
- D1 跨表归属、状态迁移和 Message/Run 关系 trigger；
- Project、Files、AgentRun 路由与 D1 adapter 的职责拆分；
- ModelGateway、SSE、异常日志和源码/产物 Secret 扫描边界；
- import boundary、Biome、真实 Workers D1、构建和浏览器 smoke 的统一门禁；
- 显式 opt-in 的 Hosted Preview 产品路径验收。

基础代码提交为 `edc6a73`（`refactor(architecture): harden release boundaries`）。

## 2. 远程发布顺序

实际执行顺序与部署文档一致：

1. 将 Preview `RUNS_ENABLED` 设为 `false`，部署锁定版本
   `7c3bf620-9ec1-44d1-9d4d-78e51866c815`。
2. 确认 `/api/health` 正常，`/api/capabilities` 明确返回
   `runCreationEnabled: false`。
3. 执行九项只读 D1 预检，所有计数为零。
4. 应用 `0006_integrity_guards.sql`，随后确认无待应用 migration。
5. 保持锁定完成 smoke，再恢复 `RUNS_ENABLED=true`。
6. 最终部署版本为 `c722c868-a0f0-4bfd-b2f4-97654d026bce`，公开能力恢复
   `runCreationEnabled: true`，AgentRuntime 仍只公开 Pi。

远程 SQL 预检同时修正为通过固定 `--command` 执行。Wrangler 的远程 `--file --json`
只返回执行汇总而不返回 SELECT 行，旧实现因此按设计失败关闭；修正后仍要求完整且唯一
的九项检查集合，任一缺失、非法或非零都拒绝继续发布。

## 3. Hosted Preview E2E

最终 `pnpm test:e2e:preview` 以退出码 0 通过，真实覆盖：

1. allowlist 用户登录并创建唯一 Project；
2. Pi 在 E2B `/workspace` 创建带随机标记的文件；
3. Cloudflare Workflow 收敛为 `succeeded`；
4. 最终 assistant Message、token 和模型请求数可见；
5. Project Inspector Files 读取到精确文件内容；
6. 第二个长任务进入运行态后取消；
7. 页面刷新后 Run 保持 `cancelled`，不产生伪造 assistant Message；
8. 用户显式停止 Project 沙箱；
9. 所有 JSON API 响应在交付页面前检查，不包含 Provider 引用、traffic token、
   Gemini/E2B Key 或 Key 特征值。

测试定位器限定在 Project Inspector 的文件行，避免用户提示词中的同名文件让
Playwright 误点 Run history。响应脱敏审计使用路由层先读取再转交页面，避免 reload
导致旧响应体不可读；测试结束前会等待在途审计关闭。

## 4. 完整门禁

发布后再次执行 `pnpm check`，结果：

- import boundary：124 个源码文件通过；
- 源码 Secret 扫描、Biome lint/format、TypeScript：通过；
- Node 单元/API：196 passed、1 个真实外部 E2E 按环境跳过；
- Workers D1：5 passed，实际应用 `0001` 至 `0006`；
- production build 与构建产物 Secret 扫描：通过；
- Chromium fake 核心 smoke：1 passed。

Hosted Preview E2E 不进入默认 `pnpm check`，避免普通提交创建真实 E2B 沙箱和 Gemini
请求；本次发布经明确授权单独执行。

## 5. 最终远程状态

- `/api/health`：正常；
- `/api/capabilities`：`runCreationEnabled: true`，公开 AgentRuntime 只有 Pi；
- D1 migration：`0001` 至 `0006` 全部应用；
- 九项发布预检：全部为零；
- SandboxLease：现有 11 条全部为 `stopped`；
- 保存 Provider 引用的 Lease：0；
- TerminalSession 与 PreviewSession：0。

E2E Project、Message、终态 AgentRun 和 usage 记录按 V1 设计保留为发布证据；没有删除
远程 D1 数据。Project 文件随沙箱停止允许丢失。

## 6. 保留限制

- 顶层 production 资源仍未配置，`pnpm deploy` 继续由 guard 阻断。
- Preview 仍为邮箱 allowlist；没有公开注册、配额、rate limit、计费或 BYOK。
- Goose 仍是服务端 `spike`，不出现在公开 capability 或 UI。
- Files/Changes 与 Provider 文件系统读取仍是尽力一致，不宣称严格事务原子性。
- 真实 E2B/Gemini E2E 会产生实际外部用量，只在发布或专项验收时显式执行。
