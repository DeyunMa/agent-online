# 协调状态诊断与恢复

> 文档状态：当前运维边界
>
> 校准日期：2026-07-27

本文处理 D1 中非终态 `agent_runs`、`terminal_sessions`、`preview_sessions` 或
`sandbox_leases` 与实际 Workflow/E2B 状态不一致的情况。它不是自动修复功能，也不是绕过产品互斥的日常操作。

## 1. 首选恢复路径

1. 先通过 UI/API 取消 Run、关闭 Terminal、停止 Preview 或停止 Project sandbox。
2. 在 Cloudflare Workflows 实例详情确认对应 execute/expiry/idle-cleanup 是否仍在运行、等待或重试。
3. 在 E2B Dashboard 确认真实 sandbox 和进程是否仍存在。
4. 等待 Workflow 和 Provider timeout 收敛后，再判断 D1 是否真的陈旧。

不能仅因 `expires_at` 已过就直接删除 Terminal/Preview 行。到期时间只触发持久清理，D1 行仍是互斥事实；盲删可能让旧 PTY/Preview 与新 Run 并行写同一 `/workspace`。

## 2. 只读诊断

在 Cloudflare Dashboard 的目标 D1 数据库 Console 中，以应用级 Project ID 查询：

```sql
SELECT id, status, sandbox_runtime_id, provider_ref, updated_at
FROM sandbox_leases
WHERE project_id = '<project-id>';

SELECT id, status, agent_runtime_id, created_at, started_at, finished_at
FROM agent_runs
WHERE project_id = '<project-id>'
ORDER BY created_at DESC
LIMIT 20;

SELECT id, sandbox_lease_id, expires_at, created_at, updated_at
FROM terminal_sessions
WHERE project_id = '<project-id>';

SELECT id, sandbox_lease_id, status, expires_at, created_at, updated_at
FROM preview_sessions
WHERE project_id = '<project-id>';
```

Provider 引用只在受信任的运维界面中用于核对，不能复制到浏览器、工单、公开日志或文档。

## 3. 人工恢复前置条件

只有以下条件全部成立时才考虑直接修复 D1：

- 已临时将 `RUNS_ENABLED=false` 并重新部署，阻止新 Run。
- 已确认没有用户正在使用目标 Project。
- 对应 Workflow 已终止或不会再次恢复写入。
- 对应 E2B sandbox 已停止，或已确认 Provider 中不存在。
- 已保存诊断结果并明确目标环境、Account、Worker 和 D1 数据库。

远程 D1 写入、Workflow 终止和 Provider 停止都是生产影响操作，必须得到明确授权。优先在 Cloudflare/E2B Dashboard 中逐项操作，避免把私有引用放进 shell history。

## 4. D1 收敛原则

Provider 和 Workflow 都已确认停止后，恢复操作应在一个受控维护窗口内完成：

- `queued` Run 收敛为 `failed`。
- `starting`、`running`、`cancelling` Run 收敛为 `interrupted`。
- 删除已失效的 Terminal/Preview 临时行。
- 将 Lease 设为 `stopped` 并清空 `provider_ref`。

这些状态转换符合当前 D1 trigger。不要把 Run 直接改成 `succeeded`，不要人工补 assistant Message，也不要只删互斥行而保留真实 Provider 进程。

本地开发数据库可以直接删除 `.wrangler/` 中对应的本地状态并重新应用迁移。远程环境不得套用本地“直接重建”策略。

## 5. 恢复后检查

1. `PRAGMA foreign_key_check;` 返回空结果。
2. 目标 Project 不再有非终态 Run、TerminalSession 或 PreviewSession。
3. Lease 为 `stopped` 且私有 Provider 引用为空。
4. 重新启用 `RUNS_ENABLED` 后，只创建一个最小 Run，并观察 Workflow、D1 和 E2B 一致收敛。
5. 公开 API、浏览器和日志中仍不存在 Provider ID、进程引用或 Key。

若同类漂移重复出现，应修复 Workflow/application 收敛逻辑并增加回归测试，不把人工清理当作正常运行机制。
