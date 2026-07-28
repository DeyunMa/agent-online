# 2026-07-28 Project 生命周期

> 状态：代码、当前事实文档、完整本地质量门禁、私有 Preview 部署和 Hosted E2E 已完成
>
> 范围：Project 重命名与硬删除；不修改 D1 schema，不新增环境变量或外部依赖

## 1. 产品结论

Project 继续同时承担代码项目和对话容器，不新增 Session、Workspace 或回收站层级：

- owner 可以在侧栏、Project 列表和 Project 页头使用同一操作菜单重命名 Project；
- 删除是不可恢复的硬删除，会级联移除 Message、AgentRun、Run usage 和
  SandboxLease；
- 活动 AgentRun、Terminal 或 Preview 存在时拒绝删除；
- 仅有空闲沙箱时，平台先通过现有 SandboxRuntime 停止它，再删除 D1 产品状态；
- Provider 停止失败时保留 Project，避免数据库已删除但沙箱仍明确存活；
- 已睡眠的旧 Workflow 在 Project/Run 已被删除后按 no-op 收敛，不重新创建状态。

Project 文件仍只有当前沙箱文件系统一份。删除 Project 会永久丢弃这些文件；本轮没有
引入 R2、快照、恢复期或删除历史。

## 2. 接口与实现

- `PATCH /api/projects/:projectId`：接收 `{ "title": string }`，执行 owner 校验、trim 和
  1 至 120 字符限制，返回更新后的 Project。
- `DELETE /api/projects/:projectId`：执行 owner 与活动资源检查、空闲沙箱停止和 D1
  级联删除，成功返回 `204`。
- Hono 只负责鉴权、请求校验和响应映射；应用编排集中在
  `ProjectManagementService`，D1 adapter 只实现 owner-scoped rename/delete。
- 删除成功后客户端返回 Projects 页面，移除 Project 范围 React Query cache，并刷新
  Project 列表与当前用户 usage。
- 操作菜单和 dialog 使用 Portal，避免移动端 Project Inspector 的 stacking context
  遮挡菜单、遮罩或删除按钮。

决策详情见 [ADR-0009](../adr/0009-project-rename-and-hard-delete.md)，当前 API 与持久化
语义分别见 [HTTP 接口](../reference/http-api.md)和
[D1 表设计](../reference/database-schema.md)。

## 3. 本地验证

`pnpm check` 通过：

| 门禁 | 结果 |
| --- | --- |
| import boundary | 142 个 source file 通过 |
| source secret scan | 通过 |
| Biome lint / format | 通过 |
| TypeScript | 通过 |
| Node unit/API tests | 235 passed，1 个显式外部 E2E skipped |
| Workers/D1 tests | 7 passed |
| production build | Worker 和 React Assets 构建通过 |
| Playwright Chromium smoke | 1 passed；含移动端 Inspector 上层菜单与删除 dialog 回归 |

测试覆盖 owner/非 owner、非法 title、活动 Run 拒绝、空闲沙箱停止、外键级联、usage
随删除收缩、旧 Workflow no-op、浏览器重命名/删除和 cache 清理。

## 4. 私有 Preview

- Worker：`agent-online-preview`
- URL：`https://agent-online-preview.mdy1145141.workers.dev`
- Cloudflare Version ID：`0c374d75-5f52-484a-9f7e-b0d0bfabd24e`
- D1：无新增或待应用 migration
- 部署前和 E2E 后：九项只读发布预检均通过
- `/api/health`：`200`
- `/api/capabilities`：公开 Runtime 仍只有 Pi，Run/Changes/Terminal/Preview 保持启用

同一部署版本的三条 Hosted E2E 均通过：

1. 基线 Pi 产品路径：真实 Run、Message、usage、Files、取消、刷新恢复、停止和响应脱敏。
2. Project 生命周期路径：真实 Run 后重命名，停止空闲 E2B sandbox，硬删除并确认旧
   Project API 为 `404`。
3. 全能力路径：同一沙箱内完成 Changes、Terminal、Files、固定 Vite Preview 和停止。

首次完整执行中，生命周期产品动作已经成功，但旧测试审计器在删除后导航时触发
Playwright `Route is already handled`。审计器随后改为只监听真实 response，不再拦截和
回放流量；生命周期用例复跑通过。最终版本另完成标准 click/键盘菜单语义和非当前
Project 删除不跳页的修正，并再次通过生命周期 Hosted E2E。

## 5. 接受的限制

- 硬删除不可撤销，不提供导出、回收站或恢复期。
- Provider 停止与 D1 删除不是跨系统事务；当前采用“停止成功后才删除”的保守顺序。
- Project 删除后，全量 usage 聚合不再包含其已删除 Run；当前 usage 是产品状态聚合，
  不是不可变账单。
- Project 列表仍无分页，当前适合个人 allowlist 数据量。
- 浏览器只看到脱敏后的 sandbox 状态，不得到 Provider sandbox ID 或底层端口。
