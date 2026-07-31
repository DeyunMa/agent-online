# ADR-0011：受控 Project 单文件上传

- 状态：Accepted
- 日期：2026-07-30
- 关联：[ADR-0002](./0002-run-agent-process-and-lease-lifecycle.md) · [当前项目架构](../reference/current-architecture.md) · [平台限制](../reference/platform-limits.md)

## 背景

Project 文件的唯一副本位于当前沙箱 `/workspace`。浏览器已有受控只读 Files，但
Composer 的回形针仍是禁用占位符，用户无法把本地文件交给当前 Project。

本项目不引入 R2、附件表、文件历史或第二份 workspace，因此上传必须直接写入现有
Project 沙箱，并遵守当前 Run、Terminal 和 SandboxLease 边界。

## 决策

### 1. 单请求只上传一个文件

浏览器通过同源 `multipart/form-data` 向
`POST /api/projects/:projectId/files` 提交字段 `file`。服务端要求：

- 用户已认证并拥有 Project；
- 文件名是 `/workspace` 根目录中的单个安全路径段；
- 文件最大 4 MiB；
- 同名文件、目录或符号链接不存在；
- Project 已有 `idle` 或 `ready` 的 lease-scoped 沙箱；
- 当前没有非终态 AgentRun 或 TerminalSession。

成功返回公开文件名、相对路径和字节数。浏览器和响应都不能得到 Provider sandbox
ID、内部路径以外的宿主信息或凭据。

### 2. 直接写当前沙箱

Application service 依赖现有窄 `SandboxFilesystemRuntime`，以 `Uint8Array` 传递文件
内容。E2B adapter 使用 SDK 的 `ArrayBuffer` 文件写入能力；SandboxRuntime 不认识
HTTP multipart、React 或 Project 所有权。

上传不创建 SandboxLease 或 Provider sandbox。新 Project 必须先通过 Agent Run 或
Terminal 建立沙箱；否则返回 `sandbox.not_active`。上传也不延长沙箱历史、不创建
恢复副本，沙箱停止后文件仍允许丢失。

### 3. 不覆盖，不自动改变 Prompt

V1 对同名路径返回 `409 file.already_exists`，避免一次误操作覆盖 Agent 或 Terminal
已创建的文件。存在检查与最终写入是尽力一致，不宣称跨并发请求的文件系统事务。

上传完成后 UI 打开 Files 并刷新 Files/Changes。它不会自动修改 Composer 文本、
创建 Message、启动 AgentRun 或把文件内容保存到 D1。

### 4. Composer 快捷入口

Composer 左侧四个入口分别为：

- 回形针：选择并上传一个本地文件；
- 文件夹：打开 Project Inspector 的 Files；
- Terminal 图标：打开 Terminal；
- Git 分支图标：打开 Changes。

后三者只是现有 Inspector 能力的导航入口，不建立第二套 Files、Terminal 或 Changes
状态。移动端点击时同时打开 Inspector 抽屉。

## 明确不做

- 多文件或目录上传、拖放、进度分片和断点续传；
- 覆盖确认、重命名、删除或写入任意子目录；
- D1/R2 附件元数据、文件副本、历史、审计或恢复；
- 自动把上传文件作为模型附件、图片输入或 Prompt 内容；
- 在没有活动沙箱时为上传单独创建沙箱。

这些能力若进入范围，需要新的产品决策和相应资源生命周期设计。

## 风险与回滚

- multipart 请求会在 Worker 内存中解析，因此同时限制 HTTP body 和实际文件字节数。
- 同名检查与写入之间存在低风险竞态；当前个人项目阶段接受尽力一致语义。
- 二进制文件可供 Agent/Terminal 使用，但现有 Files 内容预览仍只支持 256 KiB 以内的
  UTF-8 文本。

回滚时关闭 `fileUploadEnabled` capability 并移除 POST 路由即可；沙箱中已经上传的
文件按普通 Project 文件处理，不需要 D1 迁移。
