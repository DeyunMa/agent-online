# 2026-07-30 Preview 平台底座与可调检查器

> 类型：功能纵切、模板发布与远程验收快照
>
> 范围：E2B v4 平台工具链、受控 Preview 预检、覆盖式 Project Inspector Drawer、
> 受控文件上传和 Pi/Goose 浏览器选择
>
> 关联：[ADR-0006](../adr/0006-controlled-project-preview.md) ·
> [沙箱与 Agent 运行时](../architecture/02-sandbox-runtime.md) ·
> [Cloudflare 资源台账](../setup/cloudflare-preview-resources.md) ·
> [Hosted Preview E2E](../testing/hosted-preview-e2e.md)

## 1. 结论

本阶段把 Preview 从“Project 自行安装 Vite”收敛为“平台模板提供固定 Preview
底座”。Project 仍只保存自己的源码和依赖，平台不会下载依赖、执行 Project script
或读取 Project Vite 配置。

桌面控制台使用 240 px 固定 Project 栏，中间控制台始终占据完整核心区。Project
Inspector 默认关闭，以覆盖式 Drawer 展开；可访问分隔条支持拖动、方向键、
Home/End、双击复位和浏览器持久化，但调整 Drawer 不再重排中间核心区。移动端继续
使用模态 Inspector Drawer，不显示桌面分隔条。

## 2. E2B v4 模板

当前不可变 build：

```text
agent-online-pi-goose-runtime:06295331-78c7-46db-ab18-d763a51bae6c
```

模板固定并探测：

- Node `24.16.0`、npm `11.13.0`、pnpm `10.33.2`；
- Pi `0.82.0`、Goose `1.44.0`；
- Python `3.11.2`、pip `23.0.1`；
- Git、Bash、ripgrep、jq、归档、进程诊断和原生编译工具；
- `/opt/agent-online/preview` 下的平台 Vite `8.1.5`；
- 只读 `/opt/agent-online/manifest.json` 与运行用户可写的空 `/workspace`。

模型 Key、E2B Key 和用户数据均不进入模板。Pi 与 Goose 继续共用同一个 Project
沙箱，切换 Agent 不需要更换模板或丢失 `/workspace`。

## 3. Preview 合同

启动前依次检查：

1. `/workspace/index.html` 必须是根目录普通文件，否则返回
   `preview.entry_missing`；
2. 若小型、可解析的 `package.json` 声明依赖而根 `node_modules` 不存在，返回
   `preview.dependencies_missing`；
3. 通过预检后只运行
   `/opt/agent-online/preview/node_modules/.bin/vite`；
4. 只有固定内容路径返回 HTTP `2xx` 才进入 `running`，`404` 不再视为 ready。

两种预检失败是可预期的公开 `409`，不会伪装为 Provider 故障或发送 Sentry error。
真正的启动、等待和 Provider 故障使用更具体的脱敏 diagnostic stage 与稳定
fingerprint。

## 4. 验证证据

| 验证 | 结果 |
| --- | --- |
| `pnpm check` | 通过：268 unit passed / 1 skipped，7 D1 passed，5 browser passed |
| Preview/Runtime 专项单元测试 | 49 passed |
| 本地分隔条浏览器专项 | 1 passed |
| v4 模板构建与版本/权限探针 | 通过 |
| 真实 E2B + Gemini + Pi/Goose + 平台 Preview | 1 passed，约 63 秒 |
| 发布前远程协调预检 | 9 checks passed |
| 部署后健康与公开 capability | `200`；Pi/Goose 和受控能力均已公布 |
| 部署后登录态浏览器验收 | 通过 |
| 验收后远程协调预检 | 9 checks passed |

真实 adapter E2E 在同一个 v4 沙箱完成空入口预检、平台 Vite marker、
`Pi -> Goose -> Pi -> Goose cancel`、usage、文件连续性、精确取消和 Key 隔离。

部署后浏览器验收在一个临时 Project 中完成：

- Drawer 默认关闭；打开后宽度为 480 px，键盘调宽到 496 px 时核心区仍保持全宽，
  左栏保持 240 px；
- 真实 Pi Run 创建根 `index.html`，记录最终 Message、2 次模型请求和非零 token；
- Pi 写入的文件由 Files 读回，平台 Vite 在 iframe 中显示真实 marker；
- 浏览器切换 Goose 后启动长任务并取消，Run 收敛为 `cancelled`；
- 最后显式停止 Preview 和沙箱并硬删除临时 Project；删除后的 Run 用量仍在 Usage
  归档中，清理后九项远程协调预检全部通过。

## 5. 部署

Cloudflare Preview：

- URL：<https://agent-online-preview.mdy1145141.workers.dev>
- Worker Version：
  `4351a021-9e37-4882-adcc-3b767de40639`
- E2B Template：
  `agent-online-pi-goose-runtime:06295331-78c7-46db-ab18-d763a51bae6c`

Worker 与 React 源码映射均已上传到 Sentry，部署产物扫描通过且不保留 `.map`。
当前版本重新通过完整 `pnpm check` 和既有登录态真实产品纵向验收，包含覆盖式 Drawer、
Pi、Files、Preview、Goose 取消、停止、删除和用量归档。该版本从未提交工作树构建；
Sentry release 仍以当前 HEAD `a29c3d263df17f2a29f0c029b74d6e63bfdce129`
标识，因此源码提交与线上工作树尚不能一一对应。

## 6. 剩余限制

1. 当前版本从未提交工作树构建，Sentry release 只能关联部署时的 HEAD，不能完整表示
   线上改动；下一次发布前应先提交当前工作树，恢复源码映射可追溯性。
2. 依赖预检只读取小型根 `package.json` 的常规 dependency 字段，不替代完整包管理器
   状态检查；损坏或部分安装的 `node_modules` 仍可能在 Vite 启动时返回
   `preview.unavailable`。
3. 当前 Preview 只覆盖根 `index.html` 的 Vite SPA/静态页面，不提供任意 dev command、
   后端进程编排、多端口代理或持久部署。
4. 旧模板创建且仍存活的 Provider sandbox 不会原地升级；需要停止后由新 Lease
   创建流程使用 v4 模板。
