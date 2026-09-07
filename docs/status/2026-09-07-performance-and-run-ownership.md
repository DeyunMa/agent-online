# 2026-09-07 加载性能与 Run 所有权加固

本轮在 `56c419f` 基础上完成本地优化；未提交、推送、部署或修改远程资源。没有新增
依赖、D1 schema、迁移或后台服务。

## 已完成

| 问题 | 改动与证据 |
| --- | --- |
| 登录页提前下载完整控制台 | `router.tsx` 在鉴权后的 Outlet 内按需加载 ProjectConsole 和 UsagePage；未登录深链不请求这些模块。 |
| 稳定 Run 每 750 ms 查询 D1 | SSE 按 750 → 1,500 → 3,000 → 5,000 ms 退避，状态变化重置；独立的 15 秒 comment 心跳不读取 D1。 |
| Run 路由重复读取 Project | GET、cancel、events 复用已校验 userId 和 projectId 的 owned Run 查询；覆盖未登录及跨用户/Project 的拒绝行为。 |
| 旧 Run 终态后覆盖下一活动的 Lease | `updateStateForRun` 以非终态 Run 所有权、Provider 引用与更新时间为条件；在 Run 终态前释放 Lease。真实 D1 测试验证旧 Run、错误快照均不能写入或清除 Preview。 |
| 启动未返回句柄时提前取消解锁 | 先保留 `cancelling`，由启动所有者在 Provider 操作返回后收敛；未请求创建进程时不停止现有沙箱。Dispatcher 不提前终止该 Workflow。 |
| 终止失败仍释放 Run 锁 | 保留非终态和私有进程引用；已有进程引用时不升级为整箱停止，避免迟到请求误伤新 Run。 |
| 已退出的进程被误判为终止失败 | E2B `kill=false` 和明确的 SandboxNotFoundError 视为已停止；其他错误仍传播。 |

## 性能测量

相同本地 production 构建配置下，Vite 报告的入口 JS 从 **905.15 kB / gzip
275.46 kB** 降至 **389.22 kB / gzip 123.25 kB**，入口 gzip 减少 **55.3%**。
ProjectConsole 单独按需加载 512.16 kB，UsagePage 为 4.69 kB；这是首次入口成本降低，
不是总代码量减少，也不是实际网络加载时间测量。

假计时器执行 30 分钟稳定状态 SSE，D1 查询从固定轮询的 **2,400 次**降为
**361 次**，减少约 **85%**。代价是稳定状态下的新状态检测最多等待约 5 秒加
D1 请求耗时。该数值只统计单个 SSE 连接，不代表项目所有查询或费用降幅。

## 验证与剩余边界

最终 `rtk pnpm check` 全部通过：导入边界、凭据扫描、lint/format、TypeScript、
333 项单元测试、13 项隔离本地 Workers D1 迁移与仓储测试、production 构建和
9 项 Chromium smoke。1 项付费 E2B/Gemini E2E 按默认策略跳过。
生命周期回归使用受控 Promise 制造取消/创建/完成的交错；D1 回归执行真实 SQL，
不是只检查 SQL 字符串。

本轮未运行付费 E2B/Gemini 或已部署 Preview 端到端测试。控制台独立 chunk 仍略大于
500 kB，构建保留体积提示。持续 Provider 故障可能保留非终态硬锁；重复取消不会
并发启动第二次清理，Workflow 重试耗尽后按
[协调状态恢复](../operations/coordination-recovery.md)确认资源停止后处理。

E2B SDK 的终止成功表示 Provider 接受 SIGKILL 或明确进程/沙箱不存在；本轮没有
新增 Provider 服务端物理退出观测。Schema、数据留存和配额范围保持现有 ADR 边界。
