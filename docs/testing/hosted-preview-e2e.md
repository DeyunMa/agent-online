# Hosted Preview 端到端验收

> 状态：本流程是显式 opt-in 的发布后验收，不属于 `pnpm check`，不会在 CI 或普通本地
> 开发中自动创建 E2B 沙箱或 Gemini 请求。
> 关联：[私有 Preview 部署](../setup/preview-deployment.md) ·
> [adapter 级 E2B E2E](./e2b-agent-runtimes-gemini.md)

## 验收边界

`pnpm test:e2e:preview` 使用真实 Chromium，从已部署 Worker 的浏览器界面验证三条路径。

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

1. Terminal 在一个新沙箱中创建确定性 Vite/Git fixture，并留下 modified/untracked Changes；
2. Changes 列表和 diff 返回真实当前工作树；
3. 浏览器通过 WebSocket Terminal 写入文件，关闭后由 Files 回读；
4. 固定 Vite Preview 加载真实 marker，并完成显式停止；
5. 最后停止整个沙箱并再次完成 JSON API 私有状态审计。

Project 生命周期路径：

1. 创建唯一 Project并通过 Terminal 创建沙箱，使 Project 持有空闲 E2B sandbox；
2. 从 Project 操作菜单重命名并验证侧栏同步；
3. 硬删除 Project，由产品路径停止空闲 sandbox；
4. 验证页面返回 Projects、旧 Project API 为 `404`，且 JSON 响应未泄露 Provider 状态。

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

完整执行会创建两个 AgentRun 和三个 E2B 沙箱：只有基线路径使用一次真实 Pi 成功
Run 和一次可取消长任务，其余能力与 Project 生命周期使用确定性 Terminal fixture。
这样仍覆盖真实 ModelGateway/Workflow/usage/取消，同时避免用模型安装 Vite 或只为
创建沙箱而运行 Agent。成功路径会主动关闭 Terminal/Preview
并停止沙箱；测试中途失败时，`afterEach` 也会尽力按 Terminal、Preview、sandbox 顺序
清理，E2B timeout 仍是最终回收边界。Project 生命周期用例会删除自己的
Project/Message/Run/Usage；其余发布证据仍保留在 D1。

## 发布判定

- 任何登录、Run 终态、Message、usage、Files、取消或停止断言失败，都不应把该部署标记
  为通过。
- 若响应脱敏断言失败，立即把 `RUNS_ENABLED` 改回 `false` 并部署锁定版本；不要在日志
  或 issue 中复制响应正文。
- 失败产物位于 `output/playwright/preview-results`，该目录被 Git 忽略。
- 完成后在 Cloudflare Workflow、D1 和 E2B 控制台抽查资源已收敛，再记录部署版本和结果。

Terminal fixture 的 ready marker 必须由命令实际输出，不能让 marker 明文预先出现在
终端输入回显中；否则自动化会在前序命令尚未完成时误判 ready。命令还必须显式使用
`git -C /workspace` 并避免把多行文本直接拼进 shell，以保持结果可重复。

## 最近执行

2026-07-30 针对 Preview 版本 `50a111c7-1c22-4f80-8bca-0810fb772e84` 通过：

- 基线路径 27.0 秒通过：真实 Pi、Workflow、ModelGateway、最终 Message、usage、
  Files、取消、刷新恢复、停止和响应脱敏均成立；
- Project 生命周期路径 11.1 秒通过：Terminal 创建真实沙箱，重命名、停止空闲
  sandbox、硬删除和旧 Project 不可访问均成立；
- 全能力路径 34.6 秒通过：确定性 Terminal fixture、Changes、Files、Preview 和停止在
  同一沙箱中成立；
- Playwright 总结果为 `3 passed (1.2m)`；随后外层 zsh 包装误用只读变量 `status`，
  只影响 shell exit code，不代表测试失败；
- 完成后独立执行远程发布预检，九项检查全部通过。

2026-07-28 针对 Preview 版本 `0c374d75-5f52-484a-9f7e-b0d0bfabd24e` 通过：

- 基线 Hosted E2E：真实 Pi Run、Files、usage、取消、刷新恢复、停止和响应脱敏通过；
- Project 生命周期 E2E：真实 Run 后重命名 Project，停止空闲 E2B sandbox，硬删除并
  确认旧 Project API 返回 `404`；
- 全能力 Hosted E2E：Pi/Vite/Git、Changes、Terminal、Files、Preview 和停止在同一
  沙箱中通过；
- 首次完整执行的生命周期产品动作已成功，但测试审计器在删除后导航时发生
  `Route is already handled`；审计器改为只监听 response 后，生命周期用例复跑通过；
- 最终版本的菜单标准 click/键盘语义与非当前 Project 删除导航修正完成后，生命周期
  用例再次通过；
- 执行结束后九项远程预检全部为零。

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
