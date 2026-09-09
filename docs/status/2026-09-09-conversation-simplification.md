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
代码提交 `4bb0fdf9d913e5b30b1bceb555e5d13ba432d0d8` 的 GitHub CI 通过。

Hosted Playwright 脚本的 Runtime 选项与终端关闭定位已同步当前 Base UI 语义；本轮真实
环境验收使用 ego 和已有登录态，未运行需要专用登录凭据的 Hosted Playwright 命令。

## 线上 ego 验收

2026-09-09 已部署至私有 Cloudflare Preview，Worker 版本为
`ac6dc824-6d9e-4389-a481-895596b6c9cb`。本次未更改远程 schema、Secret 或 E2B 模板。

- 实际页面加载新资源；健康检查和公开 Pi/Goose capability 通过。
- 空白发送禁用、Enter 换行、真实 Ctrl+Enter 提交、成功清空草稿、活动 Run 锁定输入
  和临时工作提示通过；Pi 完成文件生成与长 Markdown 回复，刷新后消息保留。
- Pi 成功 Run `f2f9497f`：21,862 tokens、6 次模型请求；Goose Run `ef7f403f`
  真实启动后通过 UI 取消，最终 `cancelled`，2,145 tokens、1 次模型请求。
- 上传文件可在 Files 读回；Changes 显示三项 untracked 文件。Preview 返回 200，
  页面按钮实际点击后显示 `BROWSER_INTERACTION_OK`，响应具有 sandbox CSP。
- Preview 运行时 Terminal 连接并执行 `pwd`，读到 `/workspace`；切换检查器标签、
  关闭再打开及切换到 390px 布局后，终端节点与连接保留。随后显式关闭 Terminal、
  停止 Preview 和沙箱，Lease 确认为 `stopped`。
- 移动端重命名和删除临时 Project 通过，删除后 API 返回 404；原有两个 Project
  保留且均已停止。删除前后 Usage totals 完全一致，本轮四个 Run 的聚合用量为
  58,627 tokens、18 次模型请求，删除后仍进入最小用量归档。
- 清理后远程只读完整性预检 9 项通过，ego 任务空间已关闭。

线上故障注入未成功制造提交失败：离线模式令 TanStack Query 暂停请求，恢复网络后
请求继续执行；该 Pi Run `bdeb080d` 已取消。另一次 URL 阻断未生效，对应 Pi Run
`a41720b4` 正常完成。两次均发生在临时 Project，已随本轮清理，未将其计作失败草稿
验收通过。提交失败保留草稿、IME 防误提交、重复提交和 Project 草稿隔离由本地浏览器
测试覆盖；未等待完整 30 分钟 Terminal TTL，未运行专用 Hosted Playwright 命令。
