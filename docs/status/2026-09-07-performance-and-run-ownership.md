# 2026-09-07 加载性能与 Run 所有权加固

本轮在 `56c419f` 基础上完成优化。实现阶段仅本地验证，随后按用户授权提交、部署
并执行 ego 浏览器真实验收，发布证据见下节。没有新增依赖、D1 schema、迁移或后台服务。

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

本地检查未运行付费 E2B/Gemini E2E；后续真实浏览器验收见下节。控制台独立 chunk 仍略大于
500 kB，构建保留体积提示。持续 Provider 故障可能保留非终态硬锁；重复取消不会
并发启动第二次清理，Workflow 重试耗尽后按
[协调状态恢复](../operations/coordination-recovery.md)确认资源停止后处理。

E2B SDK 的终止成功表示 Provider 接受 SIGKILL 或明确进程/沙箱不存在；本轮没有
新增 Provider 服务端物理退出观测。Schema、数据留存和配额范围保持现有 ADR 边界。

## 发布与 ego 浏览器验收

- 代码提交：`e0e3fed004d9e14bac0ad2775645f90cb9f03227`。
- Git author 和 committer 均为 `DeyunMa-1`，使用对应 GitHub noreply 邮箱。
- Worker：`agent-online-preview`；版本 `ea4e8d08-f9a6-40b4-93ce-4d4916f98864`。
- 入口：<https://agent-online-preview.mdy1145141.workers.dev>；继续使用现有 Cloudflare
  Account 和 Wrangler OAuth 部署，不更改凭据或开放注册。
- `deploy:preview:dry-run`、部署前后与验收清理后的九项远程 preflight 均通过；
  Sentry 源码映射上传成功，产物凭据与安全头扫描通过。没有执行远程迁移或 Git push。

用户在 ego task space 内完成登录后，验收全部通过 UI 操作，并用同一浏览器的只读
API 查询补充状态和计量证据；没有读取、保存或填入用户密码。仅创建和清理本次测试 Project。

| 路径 | 结果 |
| --- | --- |
| 登录前加载与鉴权 | 禁用缓存后确认新入口资源；登录页未提前加载 ProjectConsole/Usage，未登录 Project API 返回 401，健康接口返回 ok。 |
| Pi 真实执行 | `69716644-cf3e-4136-8238-404cbbfc1ca5` 成功；7 次模型请求、16,293 total tokens、24,350 ms sandbox duration。最终 Message 与生成文件可读。 |
| Files / Changes | Files 读回测试文件；Changes 展示实际 unstaged diff。上传文本成功读回，重复同名上传返回明确冲突提示。 |
| Preview | 平台 Vite 在 iframe 渲染测试 marker；HTTP 200，响应 CSP 与 iframe 均含 sandbox allow-scripts。 |
| Goose 启动取消 | `90e1002e-f350-4de6-93ac-d4628c02e32d` 从启动中取消，最终 cancelled，9,010 ms，未发生模型调用。 |
| Goose 运行取消 | `6fe7e4d5-a770-4248-bdd8-9a2c58071576` 在 running 且发生模型调用后取消；1 次请求、1,862 total tokens、31,533 ms，最终 cancelled。 |
| 取消后的隔离与连续性 | 两次取消后 Preview 仍报告 running；仅 Pi 有 assistant Message，共 3 条 user / 1 条 assistant。终端可重新连接，在原沙箱写文件并由 Files 读回。 |
| 刷新与清理 | 显式关闭 Terminal、停止 Preview 和 sandbox，刷新后 Run 状态/计量一致；重命名同步侧栏，删除测试 Project 后原 API 返回 404。 |
| Usage 归档 | 删除后的 Project 仍显示 3 次 Run、8 次模型请求和约 1.8 万 total tokens；用户原有两个 Project 保留。 |
| 公开响应 | 对 Project、Run、Message、Files、Preview 五类当前 JSON 响应递归检查，未发现 Provider/进程引用或 Key 私有字段。测试期间未观察到页面 JavaScript error。 |

测试资源已清理，最后九项远程协调预检通过。此验收未等待完整 30 分钟 deadline
或 10 分钟 idle TTL，也未人为注入 Provider 网络故障；这些交错由本轮本地回归覆盖。
没有声称执行了三条 `pnpm test:e2e:preview` 自动脚本，本次使用用户指定的 ego 浏览器。
