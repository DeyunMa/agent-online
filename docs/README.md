# 文档使用说明

Agent Online 的文档按用途分层，发生冲突时按以下优先级判断：

1. 当前代码、`migrations/` 和测试是可执行事实。
2. `docs/reference/`、`CONTEXT.md` 和 `AGENTS.md` 描述当前合同与限制。
3. `docs/adr/` 记录决策原因、取代关系和启用条件，不能覆盖当前代码事实。
4. `docs/status/` 保存某个日期的验收证据，是历史快照，不自动代表最新状态。
5. `docs/proposals/` 保存尚未接受或实现的优化提案，不能当作当前能力。
6. `docs/design/` 记录视觉目标，不代表图中每项能力都已实现。

## 维护规则

- 修改跨层合同，需要同步代码、迁移、公开 DTO、相关测试和 `reference/` 文档。
- 新增或改变产品边界，先更新或新增 ADR；单纯修复正确性、拆分模块和增加门禁不需要新 ADR。
- 外部平台价格和限额只引用官方页面并标注校准日期，不把它们当作永久保证。
- 文档不得保存 Secret、Provider sandbox ID、私有进程引用或真实用户数据。
- 本地开发数据可以重建；远程资源和未知数据的修改、清理仍需明确授权。

## 当前入口

- [当前项目架构](./reference/current-architecture.md)
- [D1 表设计](./reference/database-schema.md)
- [HTTP、SSE 与 WebSocket 接口](./reference/http-api.md)
- [平台限制与限制对象](./reference/platform-limits.md)
- [协调状态恢复](./operations/coordination-recovery.md)
- [环境变量](./setup/environment-variables.md)
- [本地开发](./setup/local-development.md)
- [Hosted Preview 端到端验收](./testing/hosted-preview-e2e.md)
- [ADR-0008：错误语义与执行关联](./adr/0008-errors-and-execution-correlation.md)
- [执行关联、错误语义与架构优化路线（P0 已实现，后续候选）](./proposals/observability-errors-and-optimization-roadmap.md)
- [2026-07-27 错误语义与结构化日志](./status/2026-07-27-errors-and-observability.md)
- [2026-07-27 架构与工程门禁加固](./status/2026-07-27-architecture-hardening.md)
- [2026-07-27 Preview 发布与 Hosted E2E](./status/2026-07-27-preview-release.md)
- [2026-07-28 交付加固](./status/2026-07-28-delivery-hardening.md)
