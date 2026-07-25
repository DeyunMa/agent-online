# ADR-0001：User、Project 与 SandboxLease 边界

- 状态：Accepted（架构基线 v0.2）
- 日期：2026-07-24
- 关联：[领域术语](../../CONTEXT.md) · [系统总览](../architecture/01-system-overview.md) · [运行时](../architecture/02-sandbox-runtime.md)

## 背景

Pi Online 要实现类似 CCOnline 的浏览器编码体验，但第一版是开源、单用户项目模型，不做团队和商业支付。必须明确谁拥有文件、何时创建沙箱、浏览器是否看得到供应商 ID，以及 Pi 在哪里运行。

## 决策

1. `User` 直接拥有 `Project`；第一版不创建 Tenant、组织或 Membership。
2. `Project` 是持久对象，保存消息和 R2 Revision。
3. `SandboxLease` 是 Project 的临时、应用拥有的运行期记录；一个 Project 同时最多一个活动 Lease。
4. 多条消息和多个连续 Run 复用同一活动 Lease；每条消息不新建沙箱。
5. Lease 停止时写入 Revision；恢复项目时创建新的物理沙箱，不依赖旧实例还活着。
6. Pi、shell、终端和 preview 运行在沙箱内；认证、D1/R2、用量、配额、模型网关和密钥在沙箱外。
7. 浏览器只接触 `sandboxLeaseId` 和受控终端/preview 网关，真实供应商 ID 是服务端私有实现细节。
8. 实现 `UsageEvent`、`UsageReservation` 和 `QuotaPolicy`，但不实现任何支付或订阅领域。

## 拒绝的方案

| 方案 | 原因 |
| --- | --- |
| 每条消息创建一个沙箱 | 冷启动、成本和终端/文件连续性都很差。 |
| 每个 Project 永久运行一个沙箱 | 资源会泄漏，无法在免费/早期阶段控制成本。 |
| 两个沙箱同时写同一 Project | 文件状态冲突不可定义；以后通过项目副本/分支解决。 |
| 浏览器直连 E2B / Container | 泄露供应商 token，耦合 Provider，也绕过授权与计量。 |
| Worker 或浏览器直接运行 Pi | 不具备安全 Linux 进程、文件和终端边界。 |
| 为未来团队预建 Tenant/Membership | 当前没有产品需要，增加复杂度且会遮蔽真正的 Project/Lease 问题。 |
| 为未来商业化预建支付表 | 没有价格和产品规则，过早设计会制造错误合同。 |

## 后果

### 正面

- 用户、项目和沙箱关系直接，UI 与数据库都容易理解。
- 沙箱可见但 Provider 可替换，E2B 与 Cloudflare Containers 不会污染前端 API。
- 文件持久化和运行期资源分离，能恢复、能限额、能控制成本。
- 开源项目可完整展示 SaaS 核心逻辑，而不引入支付系统。

### 代价

- Project 级并发启动需要锁或项目级协调器，防止双 Lease。
- 需要处理 checkpoint 失败和 Lease 中断后的恢复提示。
- 团队、共享、项目分支和支付将来都需要新的 ADR，不应静默塞进本模型。

## 验收条件

1. 同一 Project 的并发 Run 不能产生两个活动 Lease。
2. 同一 Lease 上的连续 Run 可见前一 Run 的文件结果。
3. Lease 停止后，从最后成功 Revision 恢复到新 Lease。
4. 非所有者无法读取 Project、Lease、终端、preview 或 R2 对象。
5. 真正的 Gemini / BYOK Key 和 Provider sandbox ID 不出现在浏览器、日志或 R2。
