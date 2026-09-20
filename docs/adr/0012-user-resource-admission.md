# ADR-0012：用户级执行与模型请求准入

- 状态：Accepted（本地实现；远程迁移与发布未授权）
- 日期：2026-09-20
- 关联：[平台限制](../reference/platform-limits.md) · [实施记录](../status/2026-09-20-project-optimization.md)

## 背景

Project 互斥不能限制同一用户跨项目占用资源。usage 是响应返回后的事实统计，不能在
发出模型请求前限制消耗。只在应用层先查再写也会被跨 Worker 并发绕过。

## 决策

保持单 Worker/D1 架构，使用 migration 0009 的原子触发器和条件 UPDATE 实现固定护栏：

| 对象 | 准入规则 |
| --- | --- |
| 用户并发 | 非终态 Run 与 Terminal 硬锁总数最多 2；过期但未清理的 Terminal 仍计入。 |
| 用户启动频率 | UTC 固定小时窗口内，成功创建 Run 与 Terminal 合计最多 60 次。 |
| 用户模型预算 | UTC 固定日窗口内，获准转发的模型请求最多 512 次。 |
| 单 Run 模型预算 | 最多 64 次获准转发；已记录 total_tokens 达到 500000 时拒绝后续请求。 |
| 模型请求并发 | 每个 Run 最多 1 个在途请求，许可持有至响应读取与 usage 写入结束。 |

这些数值是个人开发部署的固定策略，修改必须同步 migration、查询、文档及边界测试。
固定窗口可能在边界附近出现相邻窗口的两倍短时突发，不宣称滑动窗口速率。

### 数据与原子性

- 新增每 User 至多一行 user_resource_counters，只保存小时/日期窗口和准入次数。
  Project 删除不会删除该行；User 删除级联清理。它不是事件历史、UsageReservation、
  套餐、账单或货币余额。
- AgentRun 新增私有 model_admission_count 和 model_request_active，均不进入公开
  Run DTO 或 usage 归档。model_request_count 仍只表示实际记录的 Provider usage。
- Run 与 Terminal 插入后的触发器校验总并发并更新小时计数。失败中止整个语句/batch，
  包括用户 Message；不会启动 Provider 或 Workflow。创建空逻辑 Lease 不消耗 Provider。
- 模型准入以条件 UPDATE 修改 Run，并在同一事务中由触发器消耗用户日额度。额度耗尽
  时整个 UPDATE 回滚，不能留下已占用但未转发的许可。
- 使用 RETURNING 识别目标行，不把包含触发器写入的 D1 meta.changes 当作目标行数。

### 失败与边界

- Run 准入拒绝返回 429 resource.limited；Terminal 升级后的控制消息为 resource_limited，
  随后关闭。UI 保留草稿并解释额度限制。模型请求被拒绝返回 429 resource_limit，且不访问上游。
- 许可在鉴权、模型绑定和请求格式/大小校验后取得。获准请求无论网络失败、取消、无 usage
  或 usage 写入失败，都不退回次数；释放操作只释放并发锁。
- 无法检查准入时拒绝转发。释放失败/Worker 中断可能保留该 Run 的模型请求锁；不按时间
  自动解锁，避免旧请求仍执行时再次转发。用户可取消此 Run，正常 Run deadline 仍有效。
- token 阈值使用已记录用量，最后一个被允许的响应可能超出阈值；上游未提供 usage 或
  写入失败的 token 无法准确计入。请求次数硬上限仍生效。这不是精确 token 预留或费用封顶。
- 并发数约束 Run/Terminal，不包含已经运行的 Preview 和空闲沙箱；它们沿现有 TTL 回收。
  本决策不提供全 API/IP 限流、注册反滥用、全站预算、项目存储配额或 Provider 费用保证。

## 验证与部署

真实 Workers D1 测试覆盖跨 Project 并发、Run/Terminal 混合计数、失败 batch 回滚、
用户隔离、过期 Terminal 硬锁、小时/日期切换、删除 Project 不重置额度、同 Run 模型请求
互斥、64 次上限和 token 阈值。网关测试覆盖拒绝时不访问模型、持锁直至 usage 写入，
以及失败后的释放。公开错误合同和浏览器草稿行为一起验证。

本地使用 `rtk pnpm wrangler d1 migrations apply DB --local` 应用增量迁移，不重置数据。
任何远程应用 0009、上线或回滚都需要独立授权。已有本地历史不会回填准入次数；上线前
应停用新 Run、结束 Terminal 并确认活跃请求已收敛，再执行迁移和发布匹配代码。
