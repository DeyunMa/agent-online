# ADR-0009：Project 重命名与受控硬删除

- 状态：Accepted；代码、本地测试与 Hosted E2E 已实现
- 日期：2026-07-28
- 关联：[ADR-0002](./0002-run-agent-process-and-lease-lifecycle.md) ·
  [ADR-0010](./0010-deleted-project-usage-archive.md) ·
  [D1 表设计](../reference/database-schema.md) ·
  [平台限制](../reference/platform-limits.md)

## 背景

`Project` 已同时承担代码项目、连续对话和当前沙箱文件系统的产品容器，但此前只有创建、
列表和读取接口。用户无法修正标题，也无法清理不再需要的 Project。项目仍坚持个人开源
边界，不引入回收站、软删除、R2 快照、删除历史或计费账本。

Project 删除不能只是执行一条 SQL：当前 Provider sandbox 可能仍存活，AgentRun、
Terminal 或 Preview 也可能正在修改同一文件系统；已完成 Run 的 Cloudflare Workflow
还可能正在等待 idle cleanup。

## 决策

### 1. 重命名

- `PATCH /api/projects/:projectId` 接受 trim 后 1 至 120 个字符的 `title`。
- 所有权查询使用 `(project_id, user_id)`；非所有者统一返回 `404`。
- 标题变化时同时更新 `updated_at`，因此 Project 会按最近活动重新排序。
- 相同标题直接返回当前 Project，不产生无意义写入。

### 2. 硬删除

- `DELETE /api/projects/:projectId` 是不可恢复的 Project 硬删除。
- 删除前复用 Project sandbox 停止用例。任何非终态 AgentRun、TerminalSession 或
  PreviewSession 都返回 `409 project.busy`。
- 若存在空闲 Provider sandbox，先原子脱离并调用 SandboxRuntime 停止；停止成功后才
  删除 Project。
- D1 在同一 batch 中先按 Run 把最小计量事实写入 `archived_run_usage`，再通过现有
  外键级联删除 SandboxLease、Message、AgentRun、TerminalSession 和 PreviewSession。
  all-time Usage 随后合并现存 Run 与归档用量，不因 Project 删除减少。
- Provider 停止失败或 Lease 并发冲突时保留 Project，并返回可重试错误。

### 3. Workflow 收敛

已完成 Run 的 idle-cleanup Workflow 可能在 Project 删除后醒来。`RunExecutionService`
发现对应 Run 已不存在时返回 no-op；删除已经完成了 D1 与沙箱清理，不把缺失状态报告为
执行失败。

### 4. UI

桌面侧栏、Project 列表和 Project 标题区复用同一个操作菜单。Rename 对话框禁止空标题、
未变化标题和重复提交；Delete 对话框明确列出 Message、Run 与沙箱文件的永久删除后果，
并说明聚合 Run usage 仍保留在 all-time activity。删除成功后清理 Project 查询缓存并
返回 Projects 页面。

## 未采用方案

| 方案 | 原因 |
| --- | --- |
| `deleted_at` 软删除 | 需要所有查询、用量和资源回收长期携带额外状态，不符合个人项目边界。 |
| 回收站或 R2 快照 | 引入恢复、保留、配额和对象生命周期责任。 |
| 保留完整 AgentRun 作为账单记录 | 当前 Usage 不是结算账本；最小归档避免保留运行关联和失败详情。 |
| 活动资源自动强制取消 | 删除可能与正在写文件的 Run/Terminal 竞争；明确返回 busy 更可预测。 |
| 先删 D1 再异步停沙箱 | Provider 调用失败后会失去可重试的 Lease 引用。 |

## 后果

- 删除 Project 会永久移除 Message、AgentRun 和当前沙箱文件，但保留最小 Run 用量事实。
- 当前实现不宣称删除与恶意并发请求之间具备跨 D1/Provider 的分布式事务；服务端所有权、
  活动资源检查和 Lease 条件更新提供个人阶段的受控一致性。
- 新增一张轻量 D1 归档表；不新增环境变量、R2 或外部依赖。

## 验收

1. 非所有者不能重命名或删除 Project。
2. Rename 与 Create 使用同一标题限制，UI 和列表缓存同步更新。
3. 活动 Run/Terminal/Preview 阻止删除。
4. 空闲真实沙箱在 Project 行删除前停止。
5. D1 级联后 Project、Lease、Message 和 Run 均无残留，每个 Run 的最小 usage 归档存在。
6. 休眠 Workflow 遇到已删除 Run 时 no-op。
7. 本地门禁、浏览器流程和真实 Hosted E2E 均通过。
