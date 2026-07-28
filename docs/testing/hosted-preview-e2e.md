# Hosted Preview 端到端验收

> 状态：本流程是显式 opt-in 的发布后验收，不属于 `pnpm check`，不会在 CI 或普通本地
> 开发中自动创建 E2B 沙箱或 Gemini 请求。
> 关联：[私有 Preview 部署](../setup/preview-deployment.md) ·
> [adapter 级 E2B E2E](./e2b-agent-runtimes-gemini.md)

## 验收边界

`pnpm test:e2e:preview` 使用真实 Chromium，从已部署 Worker 的浏览器界面验证两条路径。

基线路径：

1. 受邀邮箱密码登录；
2. 创建唯一 Project；
3. 启动真实 Pi Run，并等待 Cloudflare Workflow 收敛为 `succeeded`；
4. 最终 assistant Message、真实 token 和模型请求计量可见；
5. Agent 创建的文件可通过受控 Files 读取；
6. 第二个运行中 Run 可取消，刷新后没有伪造的最终 assistant Message；
7. 当前 Project 沙箱可停止；
8. 测试期间的 JSON API 响应不出现 Provider 引用、traffic token 或模型/沙箱 Key。

全能力路径：

1. Pi 在一个新沙箱中安装固定 Vite、初始化 Git 并留下 modified/untracked Changes；
2. Changes 列表和 diff 返回真实当前工作树；
3. 浏览器通过 WebSocket Terminal 写入文件，关闭后由 Files 回读；
4. 固定 Vite Preview 加载真实 marker，并完成显式停止；
5. 最后停止整个沙箱并再次完成 JSON API 私有状态审计。

这是完整产品路径，不替代 adapter 级 Pi/Goose 组合模板 E2E。后者验证 Runtime 协议和
同沙箱切换，本文验证 React、Hono、Better Auth、D1、Workflow、ModelGateway 和 E2B
组合后的公开 Pi 路径。

## 前置条件

- 已按部署文档完成 `RUNS_ENABLED=false` 锁定部署、排空、`0006` 迁移和锁定 smoke。
- 已重新部署 `RUNS_ENABLED=true`，且 `/api/capabilities` 返回
  `runCreationEnabled: true`。
- 测试账号已在 `ACCESS_ALLOWED_EMAILS` 中并完成注册。
- 工作树对应的代码已提交，部署版本可追溯。

测试只从进程环境读取以下变量，不提供默认凭据，也不把密码写入仓库：

```sh
export PREVIEW_E2E_BASE_URL=https://agent-online-preview.mdy1145141.workers.dev
export PREVIEW_E2E_EMAIL=<allowlisted-email>
read -rs "PREVIEW_E2E_PASSWORD?Preview password: "
export PREVIEW_E2E_PASSWORD
```

## 执行

```sh
pnpm test:e2e:preview
unset PREVIEW_E2E_EMAIL PREVIEW_E2E_PASSWORD
```

完整执行会创建三个 AgentRun 和两个 E2B 沙箱。成功路径会主动关闭 Terminal/Preview
并停止沙箱；测试中途失败时，`afterEach` 也会尽力按 Terminal、Preview、sandbox 顺序
清理，E2B timeout 仍是最终回收边界。测试会保留 Project、Message、Run 和 usage
作为发布证据，因为 V1 没有 Project 删除功能。

## 发布判定

- 任何登录、Run 终态、Message、usage、Files、取消或停止断言失败，都不应把该部署标记
  为通过。
- 若响应脱敏断言失败，立即把 `RUNS_ENABLED` 改回 `false` 并部署锁定版本；不要在日志
  或 issue 中复制响应正文。
- 失败产物位于 `output/playwright/preview-results`，该目录被 Git 忽略。
- 完成后在 Cloudflare Workflow、D1 和 E2B 控制台抽查资源已收敛，再记录部署版本和结果。

## 最近执行

2026-07-28 针对 Preview 版本 `9e720ed3-b4a1-4d2a-b382-4dcf48489854` 通过：

- 基线 Hosted E2E：1 passed，真实 Pi 成功 Run、取消、Files、usage、刷新恢复和停止通过；
- 全能力 Hosted E2E：1 passed，Pi/Vite/Git、Changes、Terminal、Files、Preview 和停止
  在同一沙箱中通过；
- 全能力 Run 记录 151,664 total tokens、28 次模型请求和约 59.5 秒 sandbox duration；
- API 同源拒绝、请求体 413、安全头、Static Assets CSP 和公开 Pi-only capability 通过；
- 执行结束后九项远程预检全部为零。

首次基线执行的产品 Run 已成功，但 Playwright 审计层的一个幂等 GET 遇到连接重置。
`route.fetch` 只对 GET/HEAD 增加最多两次网络错误重试，POST 保持不重放，随后重跑通过。

2026-07-27 针对 Preview 版本 `e42fedb1-e386-4427-b283-2ffda2318a9a` 再次完整通过：

- Chromium：1 个 Hosted Preview 用例通过；
- 两个真实 Pi Run 分别验证成功执行与取消；
- 最终 Message、聚合 usage、Files 内容和刷新后消息一致性通过；
- JSON API 响应在交付给页面前完成私有字段审计；
- 测试主动停止沙箱，随后九项远程预检全部为零；
- D1 已应用 `0007_agent_run_failure_codes.sql`，Run status/failure code 非法组合为 0。

发布过程和本地门禁结果见
[2026-07-27 Preview 发布与 Hosted E2E](../status/2026-07-27-preview-release.md)。
