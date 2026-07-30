# 2026-07-30 Preview 平台底座与可调检查器

> 类型：功能纵切、模板发布与远程验收快照
>
> 范围：E2B v4 平台工具链、受控 Preview 预检、桌面三栏宽度调整
>
> 关联：[ADR-0006](../adr/0006-controlled-project-preview.md) ·
> [沙箱与 Agent 运行时](../architecture/02-sandbox-runtime.md) ·
> [Cloudflare 资源台账](../setup/cloudflare-preview-resources.md) ·
> [Hosted Preview E2E](../testing/hosted-preview-e2e.md)

## 1. 结论

本阶段把 Preview 从“Project 自行安装 Vite”收敛为“平台模板提供固定 Preview
底座”。Project 仍只保存自己的源码和依赖，平台不会下载依赖、执行 Project script
或读取 Project Vite 配置。

桌面控制台保持左侧 Project 栏固定，中栏与 Project Inspector 通过一个可访问的
垂直分隔条分配宽度。拖动、方向键、Home/End、双击复位和浏览器持久化均已实现；
移动端仍使用 Inspector 抽屉，不显示桌面分隔条。

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
| `pnpm check` | 通过：260 unit passed / 1 skipped，7 D1 passed，3 browser passed |
| Preview/Runtime 专项单元测试 | 49 passed |
| 本地分隔条浏览器专项 | 1 passed |
| v4 模板构建与版本/权限探针 | 通过 |
| 真实 E2B + Gemini + Pi/Goose + 平台 Preview | 1 passed，约 63 秒 |
| 发布前远程协调预检 | 9 checks passed |
| 部署后健康与公开 capability | `200`；公开 Runtime 仍只有 Pi |
| 部署后登录态浏览器验收 | 通过 |
| 验收后远程协调预检 | 9 checks passed |

真实 adapter E2E 在同一个 v4 沙箱完成空入口预检、平台 Vite marker、
`Pi -> Goose -> Pi -> Goose cancel`、usage、文件连续性、精确取消和 Key 隔离。

部署后浏览器验收在一个临时 Project 中完成：

- 分隔条键盘调整使 Inspector 从 320 px 变为 352 px，中栏同步缩小，左栏保持
  280 px；刷新后 352 px 偏好仍保留；
- 空项目返回 `preview.entry_missing`；
- 声明依赖但没有 `node_modules` 返回 `preview.dependencies_missing`；
- 移除未安装依赖声明后，平台 Vite 在 iframe 中显示真实 HTML marker；
- Preview 运行期间真实 Pi Run 成功，记录 2 次模型请求和非零 token；
- Pi 写入的新文件可由 Files 读取，原 Preview 页面仍可访问；
- 最后显式停止 Preview 和沙箱并硬删除临时 Project，九项远程预检全部为零。

## 5. 部署

Cloudflare Preview：

- URL：<https://agent-online-preview.mdy1145141.workers.dev>
- Worker Version：
  `772c6b92-b294-4741-9b61-ef4c6db82468`
- E2B Template：
  `agent-online-pi-goose-runtime:06295331-78c7-46db-ab18-d763a51bae6c`

Worker 与 React 源码映射均已上传到 Sentry，部署产物扫描通过且不保留 `.map`。
完整真实产品 E2E 在前一版本 `37d7950c-c0ca-480e-a3e1-f60a07dc8c81` 通过；后续版本
只收敛原生 separator 样式和桌面 Project Inspector 两组横向分隔线。当前版本重新通过
完整 `pnpm check`，线上量测两组边界偏差均为 0 px，并通过健康检查与九项远程预检；
执行链路未变化，因此无需重复创建沙箱或调用 Gemini。

## 6. 剩余限制

1. 当前部署发生在工作树提交之前。Sentry 自动 release 使用部署时的 Git HEAD，不能
   单独证明本次未提交差异；代码提交后应在下一次发布重新上传源码映射，使 release
   与可追溯源码一致。
2. 依赖预检只读取小型根 `package.json` 的常规 dependency 字段，不替代完整包管理器
   状态检查；损坏或部分安装的 `node_modules` 仍可能在 Vite 启动时返回
   `preview.unavailable`。
3. 当前 Preview 只覆盖根 `index.html` 的 Vite SPA/静态页面，不提供任意 dev command、
   后端进程编排、多端口代理或持久部署。
4. 旧模板创建且仍存活的 Provider sandbox 不会原地升级；需要停止后由新 Lease
   创建流程使用 v4 模板。
