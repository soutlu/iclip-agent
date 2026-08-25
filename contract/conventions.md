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
| **Conflict** | `409` | 请求与资源**当前状态**冲突：乐观锁并发冲突、不合法的状态机转换（如撤回已撤回的需求单），以及在当前状态下不许改的字段（如改动已下发需求单的创作输入） |
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

- 返回的是这段对话**服务端最新的那份存档**。一次运行都没跑过、或者第一次运行就崩在落档之前，返回 `{ "messages": [] }`，不是 404。
- **服务端在 agent 跑出一步之后才落档**，所以最后一次运行如果崩在落档之前，用户刚发的那条消息不会出现在这里（它在服务端从未被记下）。那次运行发生了什么，由它那条流的 `RUN_ERROR` 告诉你。
- 用户消息里的附件是规范的媒体 part（`{ "type": "video", "source": { "type": "url", "value": "…" }, "metadata": { "filename": "…" } }`），跟当初发上来的一致。服务端在内部会把它换成另一副给模型看的形状，那副形状不会出现在这里。
- `system` 消息不返回。其余原样：模型上下文里有什么，这里就有什么——工具读进来的图片也照常带着它的内容出现。
- 别人的对话 `404`，口径同上。

### 上传附件

附件要先成为一个后端与模型都取得到的 **HTTP(S) 地址**，再作为媒体 part 放进消息。拿地址的口是 `POST /uploads`（见 §10）。`POST /agents/{agentId}/chat` 也接受 `source.type` 为 `data` 的内嵌 base64（单个 16MB 以内，且仅限常见图/音/视频类型），但那是兜底路径：正常路径是先把文件传上去拿到地址。

传不进来的附件不会让整条请求失败，而是在消息里原位变成一句 `[媒体不可用：…]`，模型据此知道有东西没进来。

## 7. 产品资料查询 (Products)

`GET /products/{styleNo}` 按 **PDM 款号**精确查一个款，只读、零副作用。权限 `assets:read`（三个预置角色都有）。

```json
{ "product": {
    "styleNo": "SBPU24001W",
    "styleWms": "SDFA2310W-NEW",
    "status": "effective",
    "devYear": "24",
    "brand":      { "code": "1",  "name": "Bruno Marc" },
    "category":   { "id": 52, "code": "PU", "name": "高跟鞋", "en": "Pumps" },
    "combatTeam": null,
    "colors": [{ "code": "BL02", "name": "BLACK",
                 "group": { "code": "BL", "name": "黑色系" }, "rgb": "0,0,0" }],
    "images": [{ "id": "1991", "url": "https://…/….webp", "width": 644, "height": 508 }]
} }
```

- **码永远有，名字可能为 `null`。** `brand.code` / `category.id` / `colors[].group.code` 来自上游，一定有；对应的 `name` 来自服务端的对照表，上游出现新码时就是 `null`。**前端不要自己猜名字**，也不要把 `null` 当成错误。
- **`styleWms` 不是 `styleNo` 的别名。** 它是同一个款在 WMS 那边的编号，两套编码不通用；要按款去别的系统查东西时用它。
- **`combatTeam` 目前恒为 `null`**：上游同步款资料时还没带这一列。字段先在合同里占好位置，等它有值时前端不用改。
- **`colors` 和 `images` 可能是空数组**，这是正常结果（上游资料不全），不是错误。`images[].width`/`height` 也可能为 `null`。
- 款号不存在、或已被上游标记删除，一律 `404`。
- 服务端没配目录库时这组路由整个不挂载，请求同样是 `404`。

## 8. 创作需求单 (Tasks)

一张需求单是一份记录在案的视频创作要求。它和本文其余资源最大的不同：**它没有属主，是全公司共用的一张工作队列**。谁有 `tasks:read` 谁就看得见全部——所以这里不适用「别人的一律 404」那条规则，看得见但不让你改返回的是 `403`，`404` 只意味着这张单子不存在。

| 端点 | 权限 | 说明 |
|------|------|------|
| `GET /tasks?status=&limit=20` | `tasks:read` | 列出需求单，**最近改动的排在前面**（`limit` 取值 1–100）。`status` 可选，取 `draft` / `published` / `confirmed` / `withdrawn` 之一，别的值 `422`。`200` + `{ items: [...] }` |
| `GET /tasks/{id}` | `tasks:read` | `200` + `{ task: {...} }` |
| `POST /tasks` | `tasks:write` | 提一张需求单，落地即 `draft`。请求体 `{ title, styleNo, priority?, deadline?, brief? }`（`title` 1–200 字，`styleNo` 必填，`priority` 取 0–100，默认 0）。`201` + `{ task: {...} }` |
| `PUT /tasks/{id}` | `tasks:write` | **整体覆盖**（不是局部合并）。请求体同上，`title` 必填。`200` + `{ task: {...} }` |
| `POST /tasks/{id}/publish` | `tasks:write` | 下发。`200` + `{ task: {...} }` |
| `POST /tasks/{id}/confirm` | `tasks:write` | 接单。`200` + `{ task: {...} }` |
| `POST /tasks/{id}/withdraw` | `tasks:write` | 撤回。`200` + `{ task: {...} }` |
| `DELETE /tasks/{id}` | `tasks:write` | 删掉草稿。`204` |

`task` 的形状：`{ id, title, status, priority, deadline, creatorUserId, style, brief, createdAt, updatedAt }`。`creatorUserId` 是提需求的那个人——客户端靠它判断当前用户能不能改这张草稿。**创建者取自登录身份**，请求体里带 `creatorUserId` 一类字段一律 `422`（整个请求体不接受未声明的字段）。

### 款号

款号有两个落点：`styleNo` 只在创建请求体里，是主款号；`brief.styleNos` 是要拍的款全集（≤ 20 个），**主款排首位**。不给全集，服务端补成 `[styleNo]`；给了但首位不是主款 → `422`。

`PUT` 是整体覆盖，所以这条在改动时也守着，但两种状态的结果不同：**改草稿**不给 `styleNos` 会被补回原值，首位给错 `422`；**已下发的**不给就等于动了冻结字段，返 `409`（见下文「下发即冻结」）。

`style` 是服务端按 `styleNo` 查产品资料后冻结的一份快照，形状 `{ styleNo, brand, category, previewImageUrl }`。

- **创建后不可改写**，没有端点能改。`PUT` 请求体里带 `styleNo` 或 `style` 一律 `422`。想换款就提一张新的。
- **只有 `styleNo` 一定有值。** `brand` / `category` 上游没名字时是空字符串（同 §7）；`previewImageUrl` 在这个款没有产品图时也是空字符串——**客户端要显示「主图不可用」，不要当错误，也不要拿 URL 规则去校验它**。
- `previewImageUrl` 是首图转存到本仓对象存储后的地址。它只做列表封面，不进 `brief.referenceImages`。

创建时款号这一步的失败口径：

| 情况 | 返回 |
|------|------|
| 产品资料里查不到这个款（或已被上游标记删除） | `422`，`detail` 说明是哪个款号 |
| 服务端没配产品资料库或对象存储 | `422`，不会落一张没有款的需求单 |
| 首图取不到、或转存写不进对象存储 | `5xx`，这次创建整体不落地 |

### 状态机

`draft` →（publish）→ `published` →（confirm）→ `confirmed`；`published` 与 `confirmed` 都可以（withdraw）→ `withdrawn`。

- **`withdrawn` 是终态**：改不动、删不掉、也回不到 `published`。不做了就撤回，撤回留痕；想重新来就提一张新的。
- **走不通的流转一律 `409`**，不是 `422`：撤回一张已撤回的、确认一张还是草稿的、发布一张已下发的，都是 `409`。
- **只有 `draft` 能删**，下发之后 `DELETE` 返回 `409`。

### 谁能改

- **草稿是提它的人的私事**：`PUT` 与 `DELETE` 只有创建者本人或持 `users:manage` 的治理者能做，其他人 `403`。`publish` 同理——下发是需求方的决定。
- **下发之后的流转是公事**：`confirm` 与 `withdraw` 任何持 `tasks:write` 的人都能做，`PUT` 也不再挑人（因为那时能改的只剩下面这几项）。

### 下发即冻结

`published` / `confirmed` 状态下，需求方写下的创作输入**冻结**。`PUT` 是整体覆盖，服务端会把提交上来的 `brief` 和库里的逐字段比对：

- **仍可修改**：`title`、`priority`、`deadline`（管理信息），以及 `brief` 里的 `durationSeconds`、`ratio`、`requirementDescription`、`referenceImages`、`referenceVideos`（接单之后才补得出来的那几项）。`brief.styleNos` **不在**这几项里：要拍哪几个款是需求方的决定，下发之后动它是 `409`。
- **其余 `brief` 字段有任何一项与库里不同 → `409`**，并在 `detail` 里列出是哪几个字段。所以正确的改法是：先 `GET` 拿到当前这张单子，改动允许的字段，再整体 `PUT` 回来。
- `deadline` 在非草稿状态下**不能清空**（`422`）。

### 发布关卡

`POST /tasks/{id}/publish` 会拒绝以下情况：

- 不是 `draft` → `409`
- 调用者既不是创建者也没有 `users:manage` → `403`
- 没有 `deadline` → `422`
- `brief` 里 `requirementDescription`、`theme`、`referenceImages`、`referenceVideos` **四项全空**（等于没说要做什么）→ `422`
- `deadline` 已经过去 → `409`（这个比较由服务端的数据库时钟做，不看客户端的钟）

### brief 的字段

全部可选，不填就是空字符串 / `null` / 空数组——需求方通常分几次填完。

| 字段 | 类型 | 说明 |
|------|------|------|
| `theme`、`purpose`、`audience`、`selling`、`scene`、`department`、`videoType`、`color`、`contentType`、`requester` | `string`（≤ 200） | 需求方填的创作输入 |
| `requirementDescription` | `string`（≤ 4000） | 需求描述 |
| `durationSeconds` | `int \| null` | 期望时长，取值 3–50 |
| `ratio` | `string \| null` | 画幅，取 `1:1` / `3:4` / `4:3` / `9:16` / `16:9` / `21:9` |
| `language`、`platform` | `string`（≤ 200） | 语言与投放平台 |
| `styleNos` | `string[]`（≤ 20 条，每条 1–64 字符） | 要拍的款全集，主款排首位（见上文「款号与它的快照」） |
| `referenceImages`、`referenceVideos` | `string[]`（各 ≤ 16 条） | 参考素材地址，**只收 `http://` 或 `https://`**，别的 scheme `422`。本地文件先经 `POST /uploads`（§10）换成地址 |

`brief` 不接受未声明的字段（多给一个就是 `422`）。

## 9. 爆款视频查询 (Inspirations)

`POST /inspirations/videos/search` 按款搜爆款视频，只读、零副作用。权限 `assets:read`。

```json
// 请求
{ "styleWmsList": ["SNMT241M"], "sortBy": "orders", "limit": 50 }

// 响应
{ "items": [{
    "videoId": "7519657364165856542",
    "styleWms": "SNMT241M",
    "videoUrl": "https://www.tiktok.com/@…/video/…",
    "ossUrl": "https://…/….mp4",
    "creatorHandle": "fraw_berry",
    "postedDate": "2025-06-24",
    "combatTeam": "Nortiv8",
    "category": "Casual Trainers",
    "metrics": { "impressions": 20455, "views": 152446, "clicks": 38,
                 "orders": 56, "revenue": "3171.510000" },
    "popular": { "brand": true, "kol": false, "tt": true }
}] }
```

- **`styleWmsList` 收的是 WMS 编号，不是 PDM 款号。** 两套编码不通用，传成款号会安静地搜不到东西。拿 `GET /products/{styleNo}` 响应里的 `styleWms` 来喂它。
- `sortBy ∈ impressions | views | clicks | orders | revenue`（默认 `orders`），`limit` 取值 1–100（默认 50），`styleWmsList` 1–20 个。**排序与截断都在服务端做**：换一个 `sortBy` 是换一批样本，不是把同一批本地重排。
- `metrics.revenue` 是**字符串**（十进制原样，不走浮点）；其余四项是整数。
- `popular` 三个标记彼此独立，可以同时为 `true`。
- `ossUrl` 可能为 `null`（不是每条都有转存副本），`videoUrl` 一定有。
- `category` 是**平台口径的英文类目**，和产品资料接口里的 PDM 品类不是一套，两边不互相翻译。
- 没有匹配的视频返回 `{"items": []}`，不是 404。
- 服务端没配爆款库时这组路由整个不挂载。

## 10. 上传 (Uploads)

`POST /uploads` 把一个文件变成一个公网地址。需求单的参考素材（§8）与对话附件（§6）都要求 HTTP(S) 地址，这是拿地址的唯一口。权限 `assets:write`。

```
POST /uploads
Content-Type: multipart/form-data
file: <二进制>

201
{ "upload": { "url": "https://…/uploads/<sha256>.jpg", "contentType": "image/jpeg" } }
```

- **没有素材账本**：不发 id、不记归属，产物就是那个地址，谁引用谁自己记。**没有按 id 查回来的接口**，别指望。
- **同内容同地址**：对象 key 由内容的 SHA-256 派生，重复上传拿回同一个地址，客户端不必自己去重。
- **文件名不进地址**：后缀由 content type 决定。要保留原始文件名，自己在引用侧记。
- **只收图 / 视频 / 音频**：`image/jpeg`、`image/png`、`image/webp`、`image/gif`、`video/mp4`、`video/quicktime`、`video/webm`、`audio/mpeg`、`audio/mp4`、`audio/wav`。表外的类型 `422`。
- **单个文件 ≤ 256 MiB**，超了 `422`；空文件也是 `422`。
- 对象存储写不进去 → `502`（`422` 是这个文件不该传，`502` 是该传但没传成，可以重试）。
- 服务端没配对象存储时这个端点不挂载，请求是 `404`。
