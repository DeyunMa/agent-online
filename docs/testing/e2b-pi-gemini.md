# E2B + Pi + Gemini 验证

当前只有 Pi adapter。测试文件：`src/integration/e2b-pi-gemini.e2e.test.ts`。

## 环境与作用

需要 `E2B_API_KEY`、`GEMINI_API_KEY`、新的 `E2B_TEMPLATE_ID`，以及 `cloudflared`（可用 `CLOUDFLARED_BIN` 指定）。密钥保存在被忽略的 `.dev.vars`，不得输出。测试会创建付费远程 sandbox、公开临时网关 tunnel 并调用 Gemini；执行前确认目标环境与授权。测试结束时释放 sandbox 和 tunnel。

## 步骤

1. 获得远程模板创建授权后，执行 `rtk proxy pnpm build:e2b-pi-template`，构建 Pi-only v3；它保留现有开发工具链和只读平台 Preview。
2. 将返回的精确 `agent-online-pi-runtime:<build-id>` 配置到测试环境，不能使用旧组合模板或旧 v2 模板。
3. 执行 `rtk proxy pnpm test:e2e:e2b-pi`。默认单元测试跳过这个有外部费用的测试。
4. 验证模板版本、工作区权限、平台 Preview，Pi 创建文件后下一 Run 读取修改，真实 usage、短时 capability 隔离，以及长命令取消后沙箱复用。
5. 通过后将精确 build reference 设置为发布 shell/CI 的 `E2B_TEMPLATE_ID`，再执行已获授权的发布与 hosted release 验收；发布脚本显式传入 Wrangler，无需改仓库配置。

构建或验证失败时不更新发布目标；保留前一个已验证部署。新模板与 Worker 部署不会替换已有 sandbox；清理旧 sandbox 需要先确认临时工作区可丢弃。本次本地移除尚未执行新模板构建和远程验收。
