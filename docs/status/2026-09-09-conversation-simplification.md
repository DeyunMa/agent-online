# 2026-09-09 对话界面与开发依赖简化

移除 `@assistant-ui/react`、外部 Runtime 消息转换层和 `drizzle-kit` 离线导出工具。
对话直接使用 D1 Message DTO 与现有 Run 状态，提交和取消继续通过 TanStack Query
调用 Hono API。保留安全 Markdown、shadcn/Base UI、Drizzle ORM 与原生条件 SQL。

## 行为与边界

- React 受控草稿按 Project key 隔离；仅在提交成功后清空，失败保留供重试。
- 空白任务不可发送；请求期间禁用输入与发送，同步提交锁防止重复事件。
- Enter 换行，Ctrl/Cmd+Enter 提交；IME composing/229 键事件不触发提交。
- 消息列表直接渲染已有 Message，活动 Run 单独显示临时提示，不制造持久消息。
- ResizeObserver 在用户位于底部时跟随内容变化；上翻阅读时保留当前位置。
- 删除 Drizzle Kit 配置与导出命令；继续以迁移 SQL 为物理 schema 真相源，使用已有
  Workers D1 测试检查 Drizzle 类型映射、触发器和原子操作。不更改或应用任何迁移。

## 验证与发布

初次完整 `rtk pnpm check` 通过：387 项单元测试、15 项隔离 D1 测试、15 项浏览器测试，
以及导入边界、凭据扫描、lint、格式、类型和构建检查。删除了旧消息转换函数对应的
一项单元测试，新增三个浏览器用例覆盖草稿/键盘/重复发送/Project 隔离与桌面/移动端滚动行为。

生产模式 ProjectConsole chunk 从 534.68 kB（gzip 160.42 kB）降至 268.00 kB
（gzip 约 82 kB）；这是该延迟加载块的体积，不等同于整站首屏体积。

Better Auth 1.6.25 将 Drizzle Kit 声明为可选 peer，pnpm 删除直接依赖后仍保留旧解析。
`pnpm-workspace.yaml` 使用版本限定的 removal override 排除这个未使用的 CLI 集成；
当前认证使用原生 D1 adapter，不调用其 Drizzle 迁移工具。该配置参照
[pnpm overrides](https://pnpm.io/settings/dependency-resolution#overrides)。锁文件由 pnpm
生成，未增加或升级任何 package resolution；最终少 141 个 package resolution，
`pnpm why drizzle-kit` 为空。后续升级 Better Auth 时需复核该版本限定配置。

移动端使用 document scroller，桌面使用容器 scroller；390px 回归先复现了未跟随底部，
改为按实际 CSS overflow 选择滚动对象后，两个布局的跟随与保留阅读位置均通过。
最终 `rtk pnpm check` 全部通过：387 unit、15 D1、16 browser；冻结锁文件安装也通过。
线上验收结果在发布后补充。

Hosted Playwright 脚本的 Runtime 选项与终端关闭定位已同步当前 Base UI 语义；本轮真实
环境验收使用 ego 和已有登录态，未运行需要专用登录凭据的 Hosted Playwright 命令。
