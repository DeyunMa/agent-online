# ADR-0010：删除 Project 后保留 Run 用量事实

- 状态：Accepted
- 日期：2026-07-30
- 关联：[ADR-0002](./0002-run-agent-process-and-lease-lifecycle.md) ·
  [ADR-0009](./0009-project-rename-and-hard-delete.md) ·
  [D1 表设计](../reference/database-schema.md)

## 背景

Usage 页面声明为当前用户的 `all_time` 活动，但原实现只聚合现存 `agent_runs`。Project
硬删除会级联删除 AgentRun，导致已经发生的真实 token、模型请求和沙箱时长从总量中
消失。保留完整 Project、Message 或 AgentRun 会扩大删除语义；逐模型请求的计费账本又
超出个人开源项目阶段。

## 决策

### 1. 每个删除 Run 一条归档记录

新增 `archived_run_usage`。Project 删除时，只复制每个 AgentRun 的计量与分组字段：

- `run_id`、`user_id`、Project ID 和删除时的 Project 标题；
- AgentRuntime、SandboxRuntime、Model 和终态；
- 输入、输出、总 token、模型请求数和沙箱时长；
- Run 创建、启动、完成时间与 Project 删除时间。

归档不保存 Message 关联、prompt、回复、失败详情、Provider sandbox/process 引用、文件
或 Agent 原始事件。`run_id` 和 `project_id` 是历史标签，不外键到已删除记录；
`user_id` 仍外键到 Better Auth User 并在账号删除时级联清理。

### 2. 归档与删除原子提交

公开删除用例仍先拒绝活动 Run、Terminal 或 Preview，并停止空闲沙箱。D1 adapter 随后
在同一 batch 中：

1. `INSERT ... SELECT` 当前 Project 的全部 Run 到 `archived_run_usage`；
2. 删除 Project，让现有外键清理 Message、AgentRun、Lease 和临时协调行。

归档表只接受终态 Run。`run_id` 主键和 `ON CONFLICT DO NOTHING` 使删除重试不会重复
记账；归档或删除语句失败时不能只完成其中一半。

### 3. Usage 合并读取

`GET /api/usage` 使用 `UNION ALL` 聚合现存 `agent_runs` 与
`archived_run_usage`，总量和 AgentRuntime 分组保持连续。Project 分组新增
`projectDeleted`：

- `false`：当前 Project，可以进入 Project 页面；
- `true`：已删除 Project，只显示删除时标题，不再提供链接。

仍固定为 `scope: "all_time"`，不新增时间筛选、价格、额度或管理后台。

## 未采用方案

| 方案 | 原因 |
| --- | --- |
| 每个模型请求写不可变 `usage_events` | 更适合结算与额度，但当前没有价格、账单或逐请求审计需求。 |
| 只保存一条 Project 总量 | 无法保留 Run 数、时间、AgentRuntime 和 Model 维度。 |
| 软删除 Project 或保留完整 AgentRun | 扩大所有查询和隐私删除责任，不符合当前硬删除边界。 |
| 删除后不保留任何 usage | 与 `all_time` 语义冲突，也使成本观察随用户清理 Project 而失真。 |

## 后果

- Project 内容和沙箱文件仍不可恢复；只保留最小 Run 计量事实。
- Usage 不是 Provider 账单，仍不保证价格、税、折扣或逐请求对账。
- D1 会为每个被删除 Run 长期保留一条小记录，直到 User 删除。
- 未来实施计费或强配额时，需要新的 ADR 把写入边界演进为独立 Usage Ledger，不能把
  当前归档表直接宣传为结算账本。
