# 跨端合同约定 (API Conventions)

> **核心声明**：对外的网络传输契约 (Wire Contract) **统一由后端定义**。本文档是跨端协议的唯一事实源，前端及所有外部调用方必须严格按照本约定进行对接。

## 1. 部署与路由路径

- **路径代理**：前端浏览器代码只应调用同源的 `/api/*`。在开发环境 (dev) 由 Vite Proxy 代理，在生产环境 (prod) 由 Nginx/Ingress 反向代理，将 `^/api` rewrite 掉后直达后端根路径（例如前端调用 `/api/users/me`，实际到达后端为 `/users/me`）。**本项目不设 BFF 层**。
- **WebSocket 支持**：反向代理与 Vite Proxy 必须显式放行 WebSocket upgrade（配置 `ws: true` 或透传 `Upgrade` 与 `Connection` 头）。

## 2. 双主体认证 (Dual Principals)

- **浏览器端用户**：基于 HttpOnly Cookie 的会话管理 (`iclip_session` JWT)。Cookie 完全由后端种入，浏览器原生自动携带；前端 JavaScript **绝对不持有、不存储、不转发**任何类型的 Token。
  - 登录接口：`POST /auth/login`（接受 `form-urlencoded`），成功则返回 `204 No Content` 并带上 `Set-Cookie`，响应体中不再包含 Token 数据。
- **机器端调用方**：基于 Bearer Token 的无状态调用（请求头携带 `Authorization: Bearer iclip_sk_...`）。
  - API Key 权限完全等价于其创建时的“显式授予集”（见 [ADR-0002](../docs/adr/0002-unified-permission-model.md)），不再随属主的角色变动而膨胀。其明文内容只在成功创建的响应包中下发唯一一次。
- **一致性防线**：两类主体在后端都会被一致地收拢为 `Principal` 并命中相同的路由权限与校验规则。任何由客户端自主提交的身份类字段均被视为不可信声明，将被直接抛弃或仅作普通文本处理。
- **WebSocket 握手**：浏览器的 WS 握手依赖 Cookie 校验与 Origin 校验（跨域非白名单的非法 Origin 直接触发 `Close 1008`）；机器调用的 WS 则通过标准的头信息传递 Bearer Token。

## 3. 数据载荷与格式 (Payload Formatting)

- **命名规范**：HTTP API 的所有的字段（包括 Request Body、Query Parameters 及 JSON Response）**一律采用 camelCase (驼峰命名法)**。目前有两处历史例外，新端点不得照此办理：
  - `GET /auth/sso/authorize` 的响应字段名是 `authorization_url`（前端 zod 已锁定这个名字）。
  - `POST /auth/register` 的请求体与响应体沿用 fastapi-users 自带的模型，带 `is_active` / `is_superuser` / `is_verified` 三个下划线字段。
- **当前登录态查询**：客户端判断用户是否登录的唯一事实源为调用 `GET /users/me`。
  - 成功示例：`{ "user": { ...camelCase, roles: [], directPermissions: [], permissions: [], city: "", jobTitle: "", departments: [] } }`。
  - 如果返回 `401 Unauthorized`，则代表用户当前为未登录或会话过期状态。
- **类型标准**：时间戳强制统一使用 **ISO 8601 UTC** 格式；所有的资源 ID 必须为服务端生成的不可猜测字符串。

## 4. 错误处理与响应信封

业务逻辑判定的错误（下称领域错误）统一返回 JSON 信封 `{ "detail": "<人类可读的报错消息>" }`，其状态码映射固定如下：

| 领域内部错误分类 | HTTP 状态码 | 释义与边界 |
|------------------|-------------|------------|
| **AuthenticationFailed** | `401` | 用户未登录 / 凭证无效或伪造 / API Key 已吊销或过期 |
| **PermissionDenied** | `403` | 用户已知晓资源存在，但当前拥有的权限集合不足以操作此资源 |
| **NotFound** | `404` | 资源确实不存在，**或资源存在但对当前用户不可见**（绝不越权泄露资源存在性） |
| **Conflict** | `409` | 发生乐观锁并发冲突、或者请求触发了不合法的状态机转换（如撤回已确认的任务） |
| **ValidationFailed** | `422` | 请求参数结构非法、或违反了强类型的业务语义校验规则 |

**上表之外，客户端还必须处理以下三种情况**——它们不走上面的映射，写错误处理时不要漏：

| 场景 | 实际返回 | 说明 |
|------|---------|------|
| 请求体结构不合法（少字段、类型不对） | `422`，但 `detail` 是**数组**而不是字符串 | 由 FastAPI 自己拦下，没走领域错误信封。数组里每项含 `loc` / `msg` / `type` |
| 登录、注册相关的失败 | 一律 `400` | `/auth/login` 与 `/auth/register` 直接挂 fastapi-users 自带路由：密码错误、账号被停用、用户名或邮箱重复都是 400；其中密码过短的 `detail` 是个**对象**（含 `code` / `reason`） |
| `PATCH /users/{id}` 改自己的授权、或停用自己 | `400` | 自我保护规则，不是 422 |

> **容错原则**：本项目绝不执行“部分成功 (Partial Success)”响应，也不做“静默降级”。只要客户端请求的数据结构或语义有一处非法，整次请求将原子性失败。

## 5. Agent 运行流 (Agent Run Stream)

`POST /agents/{agentId}/chat` 是唯一的 agent 对话入口，走**官方 AG-UI 协议**，不是本仓自创的格式。

- **请求体**：官方 `RunAgentInput`。七个字段全部必填，一个都不能省（少任何一个都是 `422`）：`threadId`、`runId`、`state`、`messages`、`tools`、`context`、`forwardedProps`。
  - `threadId` 即会话身份，同一会话的多次运行必须复用它——服务端据此把运行归到同一会话。它**必须是 `POST /conversations` 发放的 id**：客户端自己编一个会被拒（见下）。
  - `runId` 由客户端铸造，用来把协议事件对回本次请求、断线时找回同一条流。服务端会把它盖到这次运行的消息与快照上，但它**不是**运行记录的主键——主键由服务端自己生成，拿 `runId` 直接查主键查不到。
- **响应**：`200` + `text/event-stream`。每帧形如 `id: <位置>\ndata: <AG-UI 事件 JSON>\n\n`，首帧为 `RUN_STARTED`，终帧为 `RUN_FINISHED` 或 `RUN_ERROR`。字段名沿用 AG-UI 官方拼写（`threadId` / `runId` / `type` 等），不套用本文 §3 的 camelCase 改写规则。本端点只发 SSE，不做 `Accept` 协商。
- **运行不绑在这次请求上**：断开连接只是结束订阅，运行会继续跑完。同一个 `runId` 再 POST 一次不会重跑，而是接着读同一条流。
- **必须发 `Content-Type: application/json`**，否则 `415`——这不是洁癖，是 CSRF 防线的一半：浏览器能跨域直接发的三种 content-type 都能塞 JSON 且不触发预检，所以这里刻意要求一个非免检类型来强制预检，再由 `OPTIONS /agents/{agentId}/chat` 拒掉预检（返 `204` 且不带任何 `Access-Control-Allow-*` 头）。跨域调用方拿不到这个端点。
- **权限**：需要 `agent:run`。未注册的 `agentId` 返 `404`（不泄露它是否存在）。
- **`threadId` 必须是自己名下、且属于这个 agent 的会话**，否则 `404`：不存在、是别人的、或者当初是给另一个 agent 开的，三种情况一律当作不存在。这一步发生在开流之前，所以拿到的是正常的错误响应而不是流中途的报错。

### 断线重连

`GET /agents/{agentId}/chat/{conversationId}/{runId}` 接着读同一次运行的事件。会话 id 要跟着一起给：一次运行由「谁 + 哪段对话 + 哪个 agent + 哪次运行」共同指认，少一段就找不到。

- **位置**：把最后收到的那帧的 `id` 放进标准的 `Last-Event-ID` 请求头（浏览器原生 `EventSource` 会自动带上），也可以用 `?from=<位置>`；两个都不给就从头整段重放。
- `404`：没有这次运行（也包括别人的运行——运行只对发起它的用户可见）。
- `409`：这次运行的事件已经过了重放窗口，接不上了，要重新发起运行。**服务端绝不默默跳到当前位置**，所以收到 200 就意味着中间没有缺口。
- `422`：`runId` 或 `conversationId` 形状不合法（只允许字母、数字、`.`、`_`、`-`，不超过 128 字符），或位置的形状不合法（必须是原样回传的某帧 `id`）。
- 位置已经在末尾（该看的都看过了）：正常 `200`，然后直接收流，不再补发任何事件。
- **终帧可能是 `RUN_ERROR` 且 `code` 为 `RUN_INTERRUPTED`**：表示这次运行没跑完就断了（例如服务端进程重启），可以重新发起。它不代表模型或业务出错。
- 权限同 POST：需要 `agent:run`。

## 6. 对话 (Conversations)

一段对话就是界面上的一个聊天窗口，它的 id 即 AG-UI 的 `threadId`。**id 一律由服务端发放**：会话是服务端记录在案的事实（有归属、有名字、能删），客户端自己编一个发去 `POST /agents/{agentId}/chat` 会得到 `404`。

| 端点 | 权限 | 说明 |
|------|------|------|
| `POST /conversations` | `agent:run` | 开一段新对话。请求体 `{ agentId, title? }`，不给 `title` 就用默认名。`201` + `{ conversation: {...} }` |
| `GET /conversations?limit=20` | `agent:read` | 列出自己的对话，**最近活动的排在前面**（`limit` 取值 1–100）。`200` + `{ items: [...] }` |
| `GET /conversations/{id}/messages` | `agent:read` | 读这段对话已经发生过的消息（刷新、重新登录后靠它拿回历史）。`200` + `{ messages: [...] }` |
| `PATCH /conversations/{id}` | `agent:run` | 改名。请求体 `{ title }`。`200` + `{ conversation: {...} }` |
| `DELETE /conversations/{id}` | `agent:run` | 删掉这段对话，**agent 在这段对话里写下的工作区文件一并删除**。`204` |

- `conversation` 的形状：`{ id, agentId, title, lastRunId, createdAt, updatedAt }`。`lastRunId` 是最近一次运行的 `runId`（还没发过消息时为 `null`）——刷新页面后拿它去续读那条流。
- **只看得到自己的对话**：别人的一律 `404`，不返 `403`（那会泄露这个 id 确实有人在用）。治理者也没有看别人对话的口子。
- 删除只带走对话与它的工作区文件；`agent_runtime` 里的运行记录留着，那是账本。

### 读历史

`messages` 里是**官方 AG-UI 形状**的消息，字段名沿用 AG-UI 拼写（不套 §3 的 camelCase 改写）：它们要能原样放进 `POST /agents/{agentId}/chat` 请求体的 `messages` 再发一次。

- 一次运行都没跑过的对话返回 `{ "messages": [] }`，不是 404。
- 用户消息里的附件是规范的媒体 part（`{ "type": "video", "source": { "type": "url", "value": "…" }, "metadata": { "filename": "…" } }`），跟当初发上来的一致。服务端在内部会把它换成另一副给模型看的形状，那副形状不会出现在这里。
- `system` 消息不返回。其余原样：模型上下文里有什么，这里就有什么——工具读进来的图片也照常带着它的内容出现。
- 别人的对话 `404`，口径同上。

### 上传附件

附件要先成为一个后端与模型都取得到的 **HTTP(S) 地址**，再作为媒体 part 放进消息。`POST /agents/{agentId}/chat` 也接受 `source.type` 为 `data` 的内嵌 base64（单个 16MB 以内，且仅限常见图/音/视频类型），但那是兜底路径：正常路径是先把文件传到对象存储拿到地址。

传不进来的附件不会让整条请求失败，而是在消息里原位变成一句 `[媒体不可用：…]`，模型据此知道有东西没进来。
