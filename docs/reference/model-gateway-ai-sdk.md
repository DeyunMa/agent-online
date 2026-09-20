# ModelGateway 的 AI SDK 接入

> 2026-09-20 当前代码：仅支持 Pi；Goose 已按 [ADR-0014](../adr/0014-remove-goose-runtime.md) 移除。文中较早的验收与部署记录属于历史事实。新 Pi-only 模板需构建、验证并部署后才会改变线上环境。

## 当前实现

`ai@7.0.107` Core + `@ai-sdk/google@4.0.76` Provider 嵌入现有 Worker。
不使用 Vercel AI Gateway，不新增服务、密钥、D1 表或沙箱镜像。
本轮只接通已有 Gemini；没有新增模型选择 UI，也没有声称已验证其他供应商。

调用链为：Pi OpenAI `/chat/completions` → Run capability/额度 →
`toSdkCompletionInput` → `generateText` 或 `streamText` → Google 原生 API →
OpenAI JSON/SSE → usage 落库 → 返回 Agent。

供应商 API 细节由官方 Provider 处理，Agent HTTP 协议由项目处理。
后续接入其他 SDK Provider 时应显式配置模型路由和平台 Key、验证该 Provider 的
tool/signature/usage 合同；不接受客户端任意指定供应商或上游 URL。

## 保留的约束

- 同一 Run/model 的鉴权、用户预算和单 Run in-flight 许可保持原样。
- SDK `maxRetries=0`，流式 `streamRetries=0`；工具无 execute，不在 Worker 创建 Agent 循环。
- 120 秒 deadline 和客户端取消传入 SDK，并覆盖 HTTP body 读取。
- 请求最多 4 MiB；原生响应和转换后响应各最多 8 MiB；错误体最多 64 KiB。
- SDK telemetry 关闭、warnings 禁止直出、stream onError 不输出原始异常。
  错误仍由网关固定诊断码及脱敏响应处理，平台 Key 只进入 Google 请求头。
- Provider fetch 禁止跟随跳转；文本合同不接受图片/文件 URL，SDK downloader 也显式禁用。
- 保留 Gemini 工具 thought signature：输入接受 Pi `reasoning_details` 和 Google
  `extra_content.google.thought_signature`；输出同时提供这两种现有 Agent 协议字段。
- SDK reasoning 文本被丢弃。usage 用实际 `providerMetadata.google.usageMetadata`
  校验，缺失、不合法或总量小于输入加输出时拒绝，不能把 SDK 推导的零当实际响应。
- 继续采用原有统计口径：输入为 SDK inputTokens，输出为原生 candidatesTokenCount，
  total 为原生 totalTokenCount（包含 reasoning）；不额外记录推理内容或 token 明细。

## 协议边界

支持文本、function tools/results 和 tool choice。system/developer 消息合并为 SDK
instructions。带工具时不能强制 `parallel_tool_calls=false`，明确返回 400。
当前 Pi 配置只公开文本输入；多模态仍不属于已验证合同。

`stream=true` 使用 SDK streamText 消费原生 SSE，但保持原网关的有界缓冲行为：
响应输出一个内容/tool_calls chunk、结束原因 chunk、usage chunk、`[DONE]`。
先计量再交付，避免返回未落库的成功模型结果。非流式使用 generateText 输出完整 JSON。

## 验证与发布边界

`src/server/model-gateway.test.ts` 和 service tests 通过真实 AI SDK 调用替身 Google HTTP，
覆盖文本、工具、签名、reasoning 用量、实际 usage 缺失、请求/响应大小、超时、取消、
不重试、重定向拒绝、鉴权/额度和日志脱敏。
`model-gateway.cloudflare.test.ts` 在真实 workerd 中复用同一协议合同，验证 Worker 兼容性。

完整门禁：`rtk proxy pnpm check`。真实付费 Gemini/E2B 验收保持显式 opt-in：
`rtk proxy pnpm test:e2e:e2b-pi`。
本轮本地验证不等于远程 Pi 连续 Run 真实执行验收；未运行该验收前不得声称已通过。

上线不需要迁移或 Secret 变更；应在真实 Runtime 验收通过后按现有 Preview 发布流程上线。
本轮没有部署、提交或 push。

依据：[AI SDK Core](https://ai-sdk.dev/docs/ai-sdk-core/generating-text)、
[Google Provider](https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai)。
版本敏感行为以当前锁定包的类型和实现及项目内测试为验证依据。
