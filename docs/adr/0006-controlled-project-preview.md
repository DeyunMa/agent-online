# ADR-0006：以同源只读网关提供受控 Project Preview

- 状态：Accepted；实现与远程验收进行中
- 日期：2026-07-26
- 关联：[ADR-0002](./0002-run-agent-process-and-lease-lifecycle.md) · [ADR-0005](./0005-controlled-project-terminal.md) · [运行时边界](../architecture/02-sandbox-runtime.md)

## 背景

Agent Online 需要在 Project Inspector 中显示当前沙箱内的 Web 应用，但浏览器不能拿到
E2B sandbox ID、Provider host、固定内部端口、traffic token 或任意启动命令。第一版是
个人项目，不建设通用反向代理、动态端口发现、多 Preview、持久部署或 Preview 历史。

## 决策

### 1. Preview 是独立 Runtime capability

`SandboxPreviewRuntime` 负责固定 Preview 进程、存活探测、终止和受控 HTTP fetch。
它不进入 `AgentRuntime`，也不扩大只关心 Agent 进程的调用方接口。E2B adapter 在创建
新沙箱时设置 `network.allowPublicTraffic=false`；Worker 只在服务端使用 E2B
`trafficAccessToken`。在该策略部署前创建、没有 traffic token 的旧沙箱不会被 Preview
临时放宽，而是明确失败；新 Run 重建沙箱后再启用。

V1 只运行以下平台固定 `vite-v1` preset：

```text
cwd: /workspace
command: ./node_modules/.bin/vite --host 0.0.0.0 --port 3000 --strictPort
config: /tmp/agent-online-vite-preview.config.mjs
base: /api/projects/<projectId>/preview/content/<signed-capability>/
env: HOST=0.0.0.0, PORT=3000, BROWSER=none
```

浏览器不能传入 command、args、cwd、env、端口或 Provider 参数。项目必须在本地
`node_modules` 中安装 Vite；缺少固定二进制时 Preview 明确失败，不通过 `npx` 下载，
也不执行项目自定义 script 或加载项目自定义 Vite config。E2B adapter 在 `/tmp`
写入平台固定 config，关闭 HMR、WebSocket、文件监听和 CORS。平台在启动前生成与该
Preview session 同寿命的签名 base，
Vite 因此会把 HTML、模块依赖和 CSS 资源统一指向同源代理路径；Worker 不对任意
JavaScript 内容做字符串改写。

### 2. D1 只保存当前临时 Preview

`preview_sessions` 每个 Project 最多一行，只保存应用 ID、Lease 关联、私有
sandbox/process reference、`starting|running`、固定端口和过期时间。停止即删除，
不保存页面、日志、截图、访问历史或历史进程。

启动 Preview 时要求 Project 已有存活 Lease，且当前没有 AgentRun 或 Terminal。
`starting` 阶段通过 D1 条件写入与 AgentRun trigger 阻止并发启动；进入 `running`
后，AgentRun 和 Terminal 可以复用同一沙箱并行工作，让用户边修改边刷新 Preview。
Files 也可继续读取。活动 Preview 会阻止整沙箱手动停止和 idle cleanup。

### 3. 浏览器只访问同源签名路径

公共控制路径为：

```text
GET  /api/projects/:projectId/preview
POST /api/projects/:projectId/preview/start
POST /api/projects/:projectId/preview/stop
GET  /api/projects/:projectId/preview/content/:token/*
HEAD /api/projects/:projectId/preview/content/:token/*
```

前三条路径要求 Better Auth 和 Project 所有权。内容路径使用由
`BETTER_AUTH_SECRET` HMAC 签发、绑定 `projectId + previewSessionId + expiresAt` 的短时
平台 capability；它不是 Provider ID，也不能调用其他平台 API。每次内容请求仍回读
D1 当前行，Preview 停止后旧 token 立即失效。

Worker 只转发 GET/HEAD 和少量安全请求头，添加 Provider traffic token，并移除
Cookie、Authorization、Set-Cookie、Provider Location、内部 host 与控制头。HTML
注入同源代理 `<base>` 并重写 root-relative HTML 资源 URL。iframe 不启用
`allow-same-origin`、表单、弹窗或顶层导航，响应 CSP 禁止 connect 和 form action。

### 4. 生命周期与成本上限

启动请求同步等待固定端口最多 20 秒；失败时终止 Preview 进程并释放临时行。成功后
`preview-expiry-<sessionId>` Workflow 是 30 分钟上限的 durable owner。显式 Stop、
自然退出、探测失败或 expiry 会按记录中的 sandbox/process reference 终止进程并删除
当前行；释放后 `preview-idle-<sessionId>` Workflow 复用 10 分钟 idle TTL。

进程终止失败时不伪造 stopped，也不停止正在执行 AgentRun 或 Terminal 的整沙箱。
E2B 自身 timeout 是 Provider 故障下的最终成本边界。

## V1 限制

- 只支持一个固定端口和 `vite-v1` preset。
- 内容网关只支持 GET/HEAD，不支持表单提交、应用后端 API、WebSocket 或 HMR。
- path-based 代理会处理 HTML 中常见的相对和 root-relative URL，但不承诺重写任意
  JavaScript、CSS 或运行时生成的绝对 URL。
- Preview 不是公开部署，不提供分享链接、独立域名、SEO、访问统计或持久可用性。
- Preview 停止不删除 Project 文件；SandboxLease 停止后文件仍按 V1 规则允许丢失。

## 未采用方案

| 方案 | 不采用原因 |
| --- | --- |
| 浏览器直连 E2B URL | 泄露 Provider host/sandbox 标识，且无法统一鉴权和停止。 |
| 在 URL 中暴露 traffic token | 把 Provider 凭据交给浏览器。 |
| 任意 command/port Preview | 扩大攻击面并使生命周期、代理和 UI 状态不可预测。 |
| 第二个 Worker 或每 Project 子域 | 超出单 Worker、Cloudflare 免费层和个人项目边界。 |
| Preview 独占整个 Project 生命周期 | 会阻止 Agent 修改时实时查看结果，产品价值较低。 |
| 保存截图、页面或访问日志 | 增加不必要的存储、隐私和历史负担。 |

## 验收

1. 非所有者不能读状态、启动、停止或取得内容 capability。
2. 无存活沙箱、缺少固定 Vite 二进制、端口未就绪和 Provider 故障都有明确状态。
3. 浏览器、公共 JSON、iframe URL、响应头和日志不包含 Provider ID、host、内部端口或 Key。
4. Preview running 时可执行 Pi Run 和 Terminal；整沙箱 Stop/TTL 不会误回收。
5. Stop、进程自然退出、expiry 和沙箱消失都会收敛 D1 行并安排 idle cleanup。
6. iframe 能加载真实 HTML/JS/CSS，刷新后看见 Agent 对同一 `/workspace` 的修改。
7. 桌面与移动布局无重叠、遮挡或不可达控制。

## 后果

Preview 增加一个临时 D1 表、一项 Runtime capability、一组同源 HTTP 路径和两种
Workflow payload；不增加外部服务、环境变量、R2、Durable Object 或第二个 Worker。
