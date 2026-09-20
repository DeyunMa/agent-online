# ADR-0014：移除 Goose，执行能力仅保留 Pi

状态：接受，2026-09-20。取代 ADR-0004。

用户明确要求完整移除 Goose。删除独立 adapter、运行门控、环境变量、公开能力和安装脚本；新 Run 只接受 Pi。保留通用 AgentRuntime 端口，不增加兼容分支或回退实现。Claude Code、Codex CLI 仍为保留 ID，不能执行。

历史 AgentRun 与用量中的 runtime 名称是事实字段，读取不依赖当前可执行枚举；原始名称可以展示，但 registry 拒绝执行。Project 创建始终使用 Pi，不需要改写 Project 默认值。此次没有数据库迁移或历史数据删除。

Pi-only v3 模板保留原平台的 Node、Pi、pnpm、Python、Git、编译器与固定 Preview Vite，只去除 Goose 安装。旧 Pi-only v2 缺少现有平台能力，不能用于替代。

部署前必须构建新的 `agent-online-pi-runtime:<build-id>` 并通过真实 Pi 连续 Run、取消、文件连续性、usage 和 Preview 验证。模板引用由发布进程的 `E2B_TEMPLATE_ID` 环境变量注入，发布脚本校验并显式传给 Wrangler；仓库不固定 build ID，缺失、占位符及旧组合模板均拒绝发布。远程模板创建、配置更新、部署与旧 sandbox 停止需要目标明确的授权；不删除已有远程模板或 D1 数据。已运行的旧 sandbox 不会因修改模板配置自动更换，停止它会丢失临时工作区。

历史 ADR、状态报告与已部署资源清单保留，并标明退役状态。它们不是当前启用说明。
