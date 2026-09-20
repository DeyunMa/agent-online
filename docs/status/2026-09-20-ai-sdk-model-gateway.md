# 2026-09-20：ModelGateway 接入 AI SDK

已用 `ai@7.0.107` 与 `@ai-sdk/google@4.0.76` 替换原先手写 Gemini
OpenAI-compatible HTTP 转发。当前调用原生 Gemini API，外部保留 Pi/Goose 的
OpenAI Chat Completions 接口及签名往返。

鉴权、D1 模型准入、用量落库、120 秒 deadline、取消、大小限制、脱敏及无自动重试均保留。
移除旧 Gemini OpenAI 字段映射和流式 finish_reason 修正代码，改由 SDK Provider
处理原生协议，项目只维护 Agent 的 HTTP 兼容层。

## 验证

- 完整 `pnpm check` 退出 0：422 个单元测试通过、1 个付费 opt-in 跳过；
  59 个 Workers/D1 测试通过、原有 MCP 上游缺陷的 2 个预期失败保留；24 个浏览器测试通过。
- 随后保留旧 `invalid_model_response` 错误码，并补充拒绝供应商返回未声明工具的检查。
  针对性网关单元测试及 Workers 回归另行验证。
- Workers 测试使用实际 AI SDK 和 workerd，仅替换供应商 HTTP；覆盖工具/签名、
  reasoning 用量口径、缺失 usage、大小限制、超时/取消、错误脱敏、无重试及额度释放。
- 静态检查、生产构建和 `git diff --check` 执行通过。

## 限制与未执行项

当前仅配置 Gemini，尚未接入或验证 OpenAI/Anthropic 的模型路由及凭据。
文本之外的多模态请求，以及带工具的 `parallel_tool_calls=false` 明确拒绝；
详情见[当前合同](../reference/model-gateway-ai-sdk.md)。

真实付费 Gemini/E2B 的 Pi → Goose → Pi 验收未运行，不能把本地替身测试描述为
真实运行成功。本轮未部署、未改 Secret/远程 D1、未提交或 push；线上仍为此前 MCP 版本。
既有 MCP 上游撤销竞态没有在本轮改动。
