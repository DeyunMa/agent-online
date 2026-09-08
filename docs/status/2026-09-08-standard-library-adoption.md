# 2026-09-08 标准库接入

本轮按七项代码审查建议替换通用基础实现，保持单 Worker、D1 所有权与沙箱执行边界。
实现与本地验收阶段没有修改迁移、重置开发数据或操作远程资源；以下结果不替代
后续发布和真实环境验收记录。

## 实现范围

| 项目 | 落点与约束 |
| --- | --- |
| 标准 UI | shadcn Base UI Menu、Dialog、AlertDialog、Select 和 Tabs 承担菜单、焦点、键盘及模态行为；Inspector 保持同一 Terminal/Preview 实例。 |
| 面板缩放 | react-resizable-panels 承担桌面 Group/Panel/Separator、尺寸约束和布局持久化；移动端继续使用 Inspector 弹层。 |
| API 合同 | Shared Zod schema 推导请求、响应及生命周期事件类型；Hono JSON validator 保留同源、大小、鉴权顺序和公共错误格式，浏览器实际校验响应。 |
| 能力令牌 | jose 签发与验证 HS256 JWT；保留 Run/Preview 的 HKDF 密钥用途隔离、业务 claims、寿命和长度限制，移除手写签名编码。 |
| SSE 解析 | eventsource-parser 处理 ModelGateway 上游事件边界；保留有界缓冲、Gemini 协议修正和实际 usage 计量。 |
| D1 访问 | Drizzle schema 覆盖现有 11 张表，Project CRUD 和 Message 查询使用 D1 driver；复杂生命周期、归档和原子 batch 继续使用条件 SQL。Drizzle Kit 仅作离线 schema 导出。 |
| 表单 | React Hook Form 与 Zod resolver 管理认证和创建 Project 的字段、校验及提交状态；保留 Better Auth 和 React Query 的职责。 |

公开字段仍由服务端 DTO 显式选择，Zod 不替代授权或数据脱敏。迁移和触发器仍是
数据库部署真相源；Drizzle 导出不能用来覆盖迁移。SSE 仍发送 Run 状态和最终 usage，
本轮没有引入逐字回复或持久 Agent 会话。

Inspector 通过固定容器和 `keepMounted` Portal 保留 Terminal 实例。终端的尺寸适配
合并到下一动画帧，避免在 ResizeObserver 通知中同步写布局；浏览器测试同时检查连接
不重建和页面无错误。该调度方式参照
[ResizeObserver 的观察错误说明](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver#observation_errors)。

生成器与已安装 Base UI 的属性差异已修复在组件中，并记录于仓库
`.agents/friction-log/20260908100549-shadcn-base-tabs-attributes/friction.md`；后续重新生成
Tabs 时应保留浏览器布局验证。

## 发布注意事项

新 JWT 与旧两段 capability 不兼容。后续发布应等待活动 Run 结束并停止 Preview，
发布后重新启动 Preview，以更新 Vite base 和内容 URL；详见
[Run Workflow ADR](../adr/0003-agent-run-workflow.md) 和
[Preview ADR](../adr/0006-controlled-project-preview.md)。这不是凭据轮换或远程操作授权。

## 验证

最终 `rtk pnpm check` 全部通过：187 个源文件的导入边界、源码凭据扫描、lint、格式、
TypeScript、388 项单元测试、15 项隔离本地 Workers D1 测试、production 构建、
构建产物凭据及安全头检查，以及 13 项 Chromium 浏览器测试。D1 测试实际应用原有
迁移，并对照 Drizzle schema 的列、默认值、主键、外键、索引、唯一约束和 CHECK。
离线 `db:schema:export` 也已通过，没有生成或应用新迁移。

浏览器验证包括菜单与弹窗焦点、键盘选择 Runtime、Run 取消与刷新、Markdown 安全渲染、
上传、移动 Inspector、重命名和删除、Terminal 单连接连续性及无页面错误、桌面拖拽与
刷新恢复、认证字段和提交锁定、服务错误后重试、延迟加载与 Preview 隔离。

1 项付费 E2B/Gemini E2E 按默认门控跳过；本轮没有重新验证真实 Provider、远程部署或
线上数据。构建仍提示 ProjectConsole chunk 超过 500 kB，当前为 534.68 kB、gzip
160.42 kB；这轮不声称降低整站加载体积。库替换中的浏览器集成失败均已修复并由最终
完整检查覆盖。

## 发布验收中发现的 Terminal 布局回归

首次真实环境验收发现，Tabs 中间容器没有确定的可用高度，xterm 每次 fit 后持续撑高
父容器，产生大量远程 resize 请求，最终被终端协议队列保护断开。新增逐帧高度上界
断言后，修复前测试失败；修复 Inspector 的 flex 高度链、Panel 滚动区和 Terminal/
Preview 的剩余空间布局后通过。移动端同样使用实际剩余视口高度，避免固定最小高度
再次撑开终端。服务端队列保护保持原样。
