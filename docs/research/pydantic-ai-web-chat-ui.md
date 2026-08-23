# Pydantic AI `guides/web`：Web Chat UI 是什么

> 调研日期：2026-08-23；仅采用官方文档。

## 结论

这个页面讲的不是搜索引擎或爬虫，而是 Pydantic AI 自带的 **Web Chat UI**：安装 `pydantic-ai-slim[web]` 后，用 `app = agent.to_web()` 把已有 `Agent` 包装成 Starlette ASGI 应用，再交给 Uvicorn 运行。它相当于 Agent 的本地开发控制台，可聊天、切换配置好的模型、观察工具调用并处理审批；官方定位是**本地开发与调试**，生产环境应通过 UI Event Stream 接自建前端。[Web Chat UI 指南](https://pydantic.dev/docs/ai/guides/web/) · [`Agent.to_web()` API](https://pydantic.dev/docs/ai/api/pydantic-ai/agent/#pydantic_ai.agent.Agent.to_web) · [UI 集成](https://pydantic.dev/docs/ai/integrations/ui/overview/)

`to_web()` 只是聊天网页外壳，**不会自动让 Agent 联网**。Web Search、页面抓取和浏览器自动化是另外配置的三类能力；若 Agent 已配置原生工具，UI 才会按模型支持情况把它们显示出来。[官方说明](https://pydantic.dev/docs/ai/guides/web/)

## 前后端接口与流协议（源码核对）

以下结论按 Pydantic AI `v2.32.2` 与其绑定的 `@pydantic/ai-chat-ui@2.1.0` 核对；后端源码明确把 bundled UI 固定到 2.1.0。[版本绑定源码](https://github.com/pydantic/pydantic-ai/blob/v2.32.2/pydantic_ai_slim/pydantic_ai/ui/_web/app.py#L30-L35)

### 路由

| 路由 | 方法 | 作用 |
|---|---|---|
| `/`、`/{id}` | `GET` | 返回同一个 Chat UI HTML；`{id}` 是浏览器侧会话页面路径。 |
| `/api/configure` | `GET` | 返回 `{models, builtinTools}`。 |
| `/api/chat` | `POST` | 接收 Vercel AI UI message 请求并直接启动一次 Agent run；要求 `Content-Type: application/json`。 |
| `/api/chat` | `OPTIONS` | 拒绝授予跨域预检权限。 |
| `/api/health` | `GET` | 返回 `{"ok": true}`。 |

路由由外层应用把 API 子应用挂在 `/api`，API 子应用本身只注册 `chat/configure/health`；源码中没有 history、run-status、attach 或 resume 路由。[应用挂载](https://github.com/pydantic/pydantic-ai/blob/v2.32.2/pydantic_ai_slim/pydantic_ai/ui/_web/app.py#L198-L225) · [API 路由](https://github.com/pydantic/pydantic-ai/blob/v2.32.2/pydantic_ai_slim/pydantic_ai/ui/_web/api.py#L164-L221)

### 请求 JSON

UI 使用 `@ai-sdk/react` 的 `useChat` 与 `DefaultChatTransport`；传输层额外附加当前 `model`、`builtinTools` 和 `effort`。[UI 传输配置](https://github.com/pydantic/ai-chat-ui/blob/b9c6ae6d5a21b6a747099ae38934b99392317e2d/src/Chat.tsx#L25-L90) 一个普通提交的典型请求为：

```json
{
  "trigger": "submit-message",
  "id": "<Vercel Chat session id>",
  "messages": [
    {
      "id": "<message id>",
      "role": "user",
      "parts": [{ "type": "text", "text": "你好" }]
    }
  ],
  "model": "openai:gpt-5.2",
  "builtinTools": ["web_search"],
  "effort": "medium"
}
```

后端正式 schema 是 `SubmitMessage | RegenerateMessage`：两者都有 `id` 与完整 `messages`；`trigger` 分别为 `submit-message`、`regenerate-message`，后者还可有 `messageId`。消息由 `id`、`role`、`parts` 组成，part 可承载文本、推理、文件、来源和工具生命周期。顶层允许额外字段；`to_web()` 自己只读取并校验 `model` 与 `builtinTools`，`effort` 在这个后端入口中会被忽略。[请求类型](https://github.com/pydantic/pydantic-ai/blob/v2.32.2/pydantic_ai_slim/pydantic_ai/ui/vercel_ai/request_types.py#L343-L394) · [额外字段处理](https://github.com/pydantic/pydantic-ai/blob/v2.32.2/pydantic_ai_slim/pydantic_ai/ui/_web/api.py#L65-L90)

### 响应 stream

这不是 AG-UI，也不是 `to_web()` 自创协议，而是 **Vercel AI UI message/data stream protocol**。后端固定 `sdk_version=7`，源码注明当前 v7 与 v6 wire 相同；响应为 `text/event-stream`，带 `x-vercel-ai-ui-message-stream: v1`。每个事件编码为 `data: <JSON>\n\n`，末尾为 `data: [DONE]\n\n`。[SDK 版本](https://github.com/pydantic/pydantic-ai/blob/v2.32.2/pydantic_ai_slim/pydantic_ai/ui/_web/api.py#L23-L42) · [SSE 编码](https://github.com/pydantic/pydantic-ai/blob/v2.32.2/pydantic_ai_slim/pydantic_ai/ui/vercel_ai/_event_stream.py#L83-L140) · [SSE Content-Type](https://github.com/pydantic/pydantic-ai/blob/v2.32.2/pydantic_ai_slim/pydantic_ai/ui/_event_stream.py#L58-L188)

```text
data: {"type":"start"}

data: {"type":"start-step"}

data: {"type":"text-start","id":"..."}

data: {"type":"text-delta","id":"...","delta":"你"}

data: {"type":"text-end","id":"..."}

data: {"type":"finish-step"}

data: {"type":"finish","finishReason":"stop"}

data: [DONE]

```

实际还可出现 reasoning、tool-input/tool-output/tool-approval、source、file、data、message-metadata、error、abort 等 chunk。[完整响应类型](https://github.com/pydantic/pydantic-ai/blob/v2.32.2/pydantic_ai_slim/pydantic_ai/ui/vercel_ai/response_types.py#L23-L253)

## 刷新、重连与续传：三种语义必须分开

| 语义 | 是否支持 | 准确含义与源码证据 |
|---|---|---|
| **页面刷新后恢复历史** | **支持，但仅浏览器本地** | UI 每 500 ms 对 `messages` 做节流快照，写入当前 origin/profile 的 IndexedDB `chat-storage/messages`；打开 `/{id}` 时再读取并装回 `useChat`。它不是服务端会话存储，也不能跨浏览器/设备恢复；刷新发生在流中时，最多只显示最近一次已落盘的部分响应。[保存与加载](https://github.com/pydantic/ai-chat-ui/blob/b9c6ae6d5a21b6a747099ae38934b99392317e2d/src/Chat.tsx#L91-L171) · [IndexedDB 实现](https://github.com/pydantic/ai-chat-ui/blob/b9c6ae6d5a21b6a747099ae38934b99392317e2d/src/lib/chat-db.ts#L4-L37) · [消息读写](https://github.com/pydantic/ai-chat-ui/blob/b9c6ae6d5a21b6a747099ae38934b99392317e2d/src/lib/chat-db.ts#L98-L131) |
| **重新连接仍在运行的请求** | **不支持** | 这是基于源码路由和状态模型的直接结论：`POST /api/chat` 把 Agent run 生命周期绑定到当次 StreamingResponse；服务端没有 live-run registry、状态查询或 attach endpoint，前端也没有调用 `resumeStream`/重连接口。刷新后即使后端或模型提供商的工作短暂仍在继续，新页面也没有句柄可重新附着。[请求直接 dispatch](https://github.com/pydantic/pydantic-ai/blob/v2.32.2/pydantic_ai_slim/pydantic_ai/ui/_web/api.py#L185-L215) · [全部 API 路由](https://github.com/pydantic/pydantic-ai/blob/v2.32.2/pydantic_ai_slim/pydantic_ai/ui/_web/api.py#L216-L221) |
| **断流续传 / 游标 attach** | **不支持** | SSE 编码只发 `data:`，没有 SSE `id:`、`Last-Event-ID`、offset/cursor；请求 schema 也没有 attach/run-id/cursor 字段。因此无法从最后一个 chunk 继续消费。[事件编码](https://github.com/pydantic/pydantic-ai/blob/v2.32.2/pydantic_ai_slim/pydantic_ai/ui/vercel_ai/_event_stream.py#L119-L140) · [请求 schema](https://github.com/pydantic/pydantic-ai/blob/v2.32.2/pydantic_ai_slim/pydantic_ai/ui/vercel_ai/request_types.py#L357-L394) |
| **Retry / Continue 重新提交** | **支持，但这是新 run** | Retry 会丢弃最后一条用户消息之后的部分/完整生成，再把该用户消息重新 `sendMessage`；Continue 会提交新的字面消息 `continue`，必要时先丢弃未完成工具调用。两者都会产生新的 `POST /api/chat`，不是恢复原 HTTP 流或原 run 的断点。[UI 实现](https://github.com/pydantic/ai-chat-ui/blob/b9c6ae6d5a21b6a747099ae38934b99392317e2d/src/Chat.tsx#L208-L245) |

工具审批也容易被误称为“续传”：它是上一 run 以 deferred tool request 结束后，UI 携带批准结果再次 POST，后端据历史构造 `deferred_tool_results`；这是业务工作流跨 run 恢复，不是对仍在运行的网络流重连。[审批自动提交](https://github.com/pydantic/ai-chat-ui/blob/b9c6ae6d5a21b6a747099ae38934b99392317e2d/src/Chat.tsx#L80-L90) · [审批结果解析](https://github.com/pydantic/pydantic-ai/blob/v2.32.2/pydantic_ai_slim/pydantic_ai/ui/vercel_ai/_adapter.py#L257-L288)

## 相关 Web 能力

| 能力 | 用途与实现/提供商 |
|---|---|
| `WebSearch` | 搜索最新信息。原生适配包括 OpenAI Responses、Anthropic、Google、xAI、Groq Compound、OpenRouter，支持参数各异；也可用本地 DuckDuckGo 或自定义工具。[说明](https://pydantic.dev/docs/ai/capabilities/web-search/) · [矩阵](https://pydantic.dev/docs/ai/tools-toolsets/native-tools/) |
| `WebFetch` | 读取已知 URL。原生主要为 Anthropic、Google；本地实现用 `markdownify` 转 Markdown，不等于可执行 JavaScript 的浏览器。[说明](https://pydantic.dev/docs/ai/capabilities/web-fetch/) · [本地工具](https://pydantic.dev/docs/ai/tools-toolsets/common-tools/) |
| `XSearch` | 搜索 X/Twitter；原生来自 xAI，其他模型需显式指定 xAI 回退模型。[说明](https://pydantic.dev/docs/ai/capabilities/x-search/) |
| 搜索/研究扩展 | 通用 Tavily，以及 Harness 的 [Exa](https://pydantic.dev/docs/ai/harness/exa-search/) 和 [You.com](https://pydantic.dev/docs/ai/harness/youdotcom/)，提供来源、页面读取或深度研究封装。[通用工具](https://pydantic.dev/docs/ai/tools-toolsets/common-tools/) |
| 浏览器自动化 | [Playwright](https://pydantic.dev/docs/ai/harness/playwright/) 由主模型直接操作有状态 Chromium；[BrowserUse](https://pydantic.dev/docs/ai/harness/browser-use/) 将开放目标交给浏览器子代理，适合动态网页、登录态和多步交互，但更慢、更重。 |

## 与自行实现的区别

| 方案 | 适用场景与代价 |
|---|---|
| `agent.to_web()` | 最快得到调试界面，适合本地开发、Demo；不提供生产级认证、租户隔离、持久化或定制 UX。依赖与 `model_settings` 对所有请求固定，保留根路由且不能挂到 `/chat` 子路径。客户端提交的工具“批准”会被服务端信任，因此它不是授权边界，不能直接暴露给不可信用户。[限制与安全](https://pydantic.dev/docs/ai/guides/web/) |
| 内置/提供商工具 | 省去搜索 API 编排、工具 schema 和部分引用处理；但模型支持、参数、费用、实时性与结果透明度受提供商约束。[原生工具矩阵](https://pydantic.dev/docs/ai/tools-toolsets/native-tools/) |
| 自行实现 HTTP/爬虫/搜索工具 | 可控制认证、代理、Cookie、缓存、去重、排序、解析、限流与合规，适合企业内网、定制索引及高确定性生产流程；相应地要自行承担 schema、错误/重试、引用、SSRF、提示注入、测试和维护。[自定义 Function Tools](https://pydantic.dev/docs/ai/tools-toolsets/tools/) |

安全上还应把网页内容视为不可信输入；本地抓取尤其要限制目标域名，并防范 SSRF 与敏感请求头泄露。[Web Fetch 安全说明](https://pydantic.dev/docs/ai/tools-toolsets/common-tools/)
