# 跨端合同约定 (API Conventions)

> **机器可读的那一半在 [`openapi.json`](openapi.json)**：由 `make contract` 从后端导出，前端 `pnpm contract:generate` 据此生成类型与 zod。端点、字段与状态码以它为准；本文写的是它表达不了的部分。两者不一致时以 openapi.json 为准，并回来修本文。

## 1. 部署与路由路径

- **路径代理**：前端浏览器代码只调用同源的 `/api/*`。在开发环境 (dev) 由 Vite Proxy 代理，在生产环境 (prod) 由 Nginx/Ingress 反向代理，将 `^/api` rewrite 掉后直达后端根路径（前端调用 `/api/users/me`，实际到达后端为 `/users/me`）。

## 2. 双主体认证 (Dual Principals)

- **浏览器端用户**：基于 HttpOnly Cookie 的会话管理 (`iclip_session` JWT)。Cookie 完全由后端种入，浏览器原生自动携带；前端 JavaScript **不持有、不存储、不转发**任何类型的 Token。
- **机器端调用方**：基于 Bearer Token 的无状态调用（请求头携带 `Authorization: Bearer iclip_sk_...`）。
  - API Key 权限等价于其创建时的显式授予集（见 [ADR-0002](../docs/adr/0002-unified-permission-model.md)）。其明文内容只在成功创建的响应包中下发唯一一次。

## 3. 数据载荷与格式 (Payload Formatting)

- **命名规范**：HTTP API 的所有字段（包括 Request Body、Query Parameters 及 JSON Response）**一律采用 camelCase**。两处例外：`GET /auth/sso/authorize` 的响应字段 `authorization_url`；`POST /auth/register` 请求体与响应体的 `is_active` / `is_superuser` / `is_verified`。新端点不得照此办理。
- **当前登录态查询**：客户端判断用户是否登录的唯一事实源为调用 `GET /users/me`；返回 `401 Unauthorized` 代表用户当前为未登录或会话过期状态。
- **类型标准**：时间戳统一使用 **ISO 8601 UTC** 格式；所有的资源 ID 必须为服务端生成的不可猜测字符串。

## 4. 错误处理与响应信封

领域错误统一返回 JSON 信封 `{ "detail": "<人类可读的报错消息>" }`，其状态码映射固定如下：

| 领域内部错误分类 | HTTP 状态码 |
|------------------|-------------|
| **AuthenticationFailed** | `401` |
| **PermissionDenied** | `403` |
| **NotFound** | `404`：资源不存在，**或资源存在但对当前用户不可见** |
| **Conflict** | `409`：请求与资源**当前状态**冲突——乐观锁并发冲突、不合法的状态机转换、当前状态下不许改的字段 |
| **ValidationFailed** | `422` |

上表之外：`PATCH /users/{id}` 改自己的授权、或停用自己返回 `400`。

## 5. Agent 对话 (Transcript)

agent 对话走 **kimi code 的 transcript 协议**，端点都挂在一段对话下面。

### 字段名：这一面照协议原样，不套 §3

transcript 面是唯一不按 §3 用 camelCase 的地方，因为客户端的 reducer 是照抄来的 zod schema，
形状对不上整帧被拒。两种写法在同一个 JSON 里并存，是协议本来的样子：

- **信封 snake_case**：`agent_id`、`has_more_older`、`has_more`、`latest_seq`、`prompt_id`、
  `since_seq`、`before_turn`、`page_size`。
- **里面装的实体与操作 camelCase**：`turnId`、`stepId`、`frameId`、`toolCallId`、`hasMoreOlder`。

```json
{"type": "transcript.reset", "agent_id": "main", "seq": 12,
 "snapshot": {"items": [], "hasMoreOlder": true}}
```

### 发消息

`POST /conversations/{id}/prompts`，体是 `{prompt_id, content}`。

- `prompt_id` 由客户端铸（乐观气泡靠它认领服务端回来的那条）。同一段对话里重发同一个 id
  返回已有那条，不会多起一次运行；换一段对话用同一个 id 是 `409`。
- `content` 是一串 part：`{"type":"text","text":…}`、`{"type":"image","source":{"kind":"url","url":…}}`、
  `{"type":"video", …}`。
- 答复是这条消息的记录：这段对话空着就 `status: "running"`，正忙就 `"queued"`。
- 权限 `agent:run`，且必须是自己名下的对话，否则 `404`。

### 读

- `GET /conversations/{id}/transcript` 一页轮子。不给位置就是最新那几轮；往上翻给
  `before_turn`，`page_size` 1–100（默认 20）。`has_more` 说的是更旧的那一头。
- `GET /conversations/{id}/transcript/ops?since_seq=` 补断线期间漏掉的批次。
  `complete: false` 表示要的批次已经出了窗口，整页重拉。
- `GET /conversations/{id}/prompts` 当前排程：`{active, queued}`。

### 停止、插话、审批、重新生成

- `POST /conversations/{id}/prompts/{promptId}:abort`：排队的直接撤，在跑的发取消让它自己
  收尾。已经结束的是 `409`。
- `POST /conversations/{id}:abort`：停整段对话——排着的**全部**撤掉，在跑的那条发取消。什么
  都没在跑照样是 `204`。**别拿上一条逐条撤**：撤到一半在跑的那条结束了，还没撤到的队首会被
  顶上来接着跑。
- `POST /conversations/{id}/prompts:steer`，体 `{prompt_ids}`：把排队中的几条插进正在跑的
  那一轮，不必等它跑完。没有在跑的运行是 `409`。
- `POST /conversations/{id}/turns/{turnId}:regenerate`：把**最后一轮**抹掉重跑——按轮寻址，
  `turnId` 是协议里的轮 id（`t{N}`，轮头部上就带着）。服务端找到发起那一轮的消息，取出原
  内容，落库历史截回该轮之前，另铸一个 `prompt_id` 重新开跑，答复是重跑那条的记录（形状同
  发消息）。只允许对最后一轮、且对话**空闲**时调用：在跑或排着、动的不是末轮（轮号超出现有
  轮数也算）都是 `409`；轮 id 不是 `t{N}` 的形状是 `422`；那一轮在库里找不到对应的消息记录
  是 `404`。旧那一轮的运行记录留库不清，界面上它被重跑出来的新一轮顶替（轮号复用同一个
  `t{N}`）。
- `POST /conversations/{id}/interactions/{interactionId}`，体 `{approved}`：对审批卡点头或拒绝。
  工具就在同一次运行里等这个回话。没有等着回应的那张卡是 `404`。

### 订阅

`WS /ws`，**一条连接管多段对话**——地址里没有对话 id，订哪几段由帧说。**帧的 schema 不在
openapi 里**：它归照抄来的 `packages/transcript` zod schema，前端 vendor 那一份，不另写也
不手写。

- 握手：服务端先发 `server_hello`（客户端只取 `heartbeat_ms`），客户端**每段对话各发一帧**
  `subscribe_v2`，体里 `session_id` 是对话 id，`transcript` 是按 agent 给的档位，带
  `transcript_since` 就是补批。协议里的 `client_hello` 我们不收。
- 退订一段发 `unsubscribe_v2`（体里 `session_id`）；关连接就是全退。
- **订阅逐段核权**：看不见的对话与不存在的对话一个待遇——回执 `ack` 的 `payload.not_found` 里
  带上它，整条连接不动（其余对话照旧）。建连时只核登录与 `agent:run`。
- 服务端发来的每一帧带 `session_id`，**客户端按它分流**；水位也按对话各记一份。
- 服务端每 10 秒发一帧 `ping`；连着两个周期没有收到**任何**入站帧就断开（`1001`）。
- 每段对话第一次订阅收到一帧 `transcript.reset`（档位是 `off` 时一帧都不发，见下），其后是
  `transcript.ops`。**reset 里的 `seq` 会无条件覆写客户端本地水位**（不是取较大值）——进程重启
  后批次号从 1 重来，靠的就是这条。
- 跨域的升级请求直接关（`1008`）：WS 不受 CORS 约束，浏览器照常带 cookie。
- 服务端积压超过上限会关连接（`1013`），重连补批即可。积压上限按连接算，不按对话。

#### 档位

`subscribe_v2` 的 `transcript` 是 `{agentId: 档位}`，四档 `off / turn / block / delta`。打开的
那段用 `delta`，侧栏里盯着的用 `turn`。

| 档位 | 收得到 | 收不到 |
|---|---|---|
| `off` | 什么都没有：连 `reset` 也不发，所以水位也不会初始化 | 全部 |
| `turn` | `turn.upsert`、`prompt.upsert`、`interaction.upsert`、`attachment.upsert`、`meta.merge`、`items.remove` | 逐字与块级 |
| `block` | 上面那些，加 `step.upsert`、`frame.upsert` | `append` |
| `delta` | 全部 | — |

- **不给档位就是 `off`**，不是「全都要」：查法是 `transcript[agentId] ?? transcript["*"] ?? "off"`。
- 筛空了的批次**整批不发**，客户端水位就停在原处。这样安全的前提是：`append` 是唯一不可重放
  的操作，而它只在 `delta` 档留得下来，而 `delta` 档不筛任何东西。
- **档位调高必须重订，服务端会先发一帧 `reset`**（给了 `transcript_since` 也不理）：低档时被
  筛空丢掉的那些批次补不回来。调低不用重来。
- **`off` 不等于退订**：订阅还在，服务端那边照样占着这段对话的实时状态。不要用 `off` 省资源，
  不看了就 `unsubscribe_v2`。

#### 全局帧

两帧**都不看订阅**：发给这个人当时连着的每一条连接，一段都没订也收得到。

| 帧 | 体 | 什么时候发 |
|---|---|---|
| `session.meta.updated` | `{session_id, title}` | 标题变了（自动起名或用户改名） |
| `event.session.work_changed` | `session_id` 在信封上，payload `{busy, pending_interaction, last_turn_reason}` | jobs 表里占着的那条行状态变了：起跑、进 awaiting、审批点齐、收场、撤回等审批的、清扫判失败 |

- 侧栏列着几十段对话却一段都没订，所以它只能走这条路；客户端拿它就地改那一行，不重拉列表。
- **按属主派发**，不是见者有份：连接归谁由它握手时的主体定。
- 它们的 schema 不在 vendor 那份里——vendor 是照抄来的、不改，而它的 zod 默认静默丢掉未知字段。
  所以这些字段不进 `TranscriptMeta`，另立帧，schema 写在 `connection.ts` 边上。
- **两帧都是易失的**：不进任何日志，掉了就是掉了。所以同一份事实也长在列表行上
  （`ConversationOut.title` 与 `ConversationOut.activity`）——**行是事实源，帧只负责「不必等下一次
  重拉」**。客户端重连之后要重拉一次列表：断线期间的变化谁也补不回来。
- 一条跑完接着起下一条会先发 idle 再发 busy。

## 6. 对话 (Conversations)

**id 一律由服务端发放**，客户端自己编一个拿去发消息会得到 `404`。

**权限**：`POST /conversations`、`PATCH /conversations/{id}`、`PUT /conversations/{id}/collection`、`PUT /conversations/{id}/task`、`DELETE /conversations/{id}` 需要 `agent:run`；`GET /conversations`、`GET /conversations/ungrouped`、`GET /conversations/by-collection/{id}`、`GET /conversations/search`、`GET /conversations/audit`、`GET /conversations/by-task/{taskId}`、`GET /conversations/{id}/workspace/files`、`GET /conversations/{id}/workspace/file` 需要 `agent:read`。

- `GET /conversations` 返回**侧栏拓扑**：`{ collections: [{ id, name, updatedAt, conversationCount, page }], ungroupedCount, ungrouped }`。`page` 与 `ungrouped` 都是一页 `{ items, nextCursor }`；合集与「没归类」两区都只有自己的，各按最近活动倒序；每个合集第一页 10 段，`ungrouped` 第一页 20 条，空合集也在列表里。
- **两个数字是真总数**：`ungroupedCount` 与每个合集的 `conversationCount`，与这一页给了几条无关。
- 往下滑加载更多：`GET /conversations/ungrouped?cursor=` 与 `GET /conversations/by-collection/{collectionId}?cursor=`，都返回 `{ items, nextCursor }`。`cursor` 原样回传上一页的 `nextCursor`（把它当不透明字符串），为 `null` 表示没有更多了；形状不对是 `422`。
- **`by-collection` 不区分「合集不存在」「合集是别人的」「合集是空的」**，三种都给一页空的——合集只对属主可见，区分了就等于告诉调用方它存在。
- `GET /conversations/search?q=` 按标题搜自己的对话，返回扁平列表，最近活动的排在前面；`GET /conversations/by-task/{taskId}` 按开始时间正序。
- `lastRunId` 是最近一次运行的 `runId`（还没发过消息时为 `null`），刷新页面后拿它去续读那条流。
- `activity` 是这段对话此刻在忙什么：`{busy, pendingInteraction, lastTurnReason}`。前两个字段**互不
  蕴含**——等审批时 `busy` 照样为真，那一轮并没有结束。`lastTurnReason` 是最近一轮的结局
  （`completed` / `failed` / `aborted`），从没跑过的对话为 `null`。变化走
  `event.session.work_changed`（见 §5 全局帧）。
- **标题服务端自动起，只起一次**：第一轮跑完拿小模型按用户那句话起个名，写进去之后再不改；
  用户自己改过名（`PATCH`，或者开对话时就给了 `title`）的一律不碰。起不出来就还叫默认名，下一
  轮跑完再试，不报错。改名与自动起名都会发一帧 `session.meta.updated`（见 §5 全局帧）。
- 会话页首屏的标题在 `GET /transcript` 响应的顶层 `title` 上——**不在 `meta` 里**（那是协议形状，
  加字段会被客户端静默丢掉）。之后的变化只走推送，不用轮询。
- **可见性**：只看得到自己的对话，别人的一律 `404`，不返 `403`。按需求单列尝试同一口径：只列自己的。
- 删除对话时，**agent 在这段对话里写下的工作区文件一并删除**；`agent_runtime` 里的运行记录留着。
- 工作区文件只读，没有推送：`version` 变了内容才变，客户端按它决定要不要重读正文。什么时候重拉列表由客户端定，事件流里每有一个工具调用出结果就拉一次。

### 两处归属

`taskId` 说的是这段对话记在哪张需求单下，`collectionId` 说的是它放在哪个合集里。两个都可以不给，都可以随时改。

- **一张单下面可以有好几段对话**，每段就是一次尝试；第几次按 `createdAt` 排——事后补挂的老对话会按它自己的开始时刻插到前面去。
- `taskId` 用 `PUT .../task` 改，`collectionId` 用 `PUT .../collection` 改，给 `null` 就是摘掉；**一段对话最多挂一张单、最多待在一个合集里**。
- 两处都给不存在的 id 是 `422`。
- 两处归属互不要求：对话在哪个合集里，与它记在哪张单下无关。
- **删合集、删需求单都不带走对话**，只把对话上那一列置空。

### 治理者复盘

内部平台要按单、按人复盘创作质量，所以持 `users:manage` 的治理者读得到别人的对话——**只读**，改名、换归属、删除、发消息一律仍限属主（别人的对话对写入路径就是不存在）。

- `GET /conversations/audit` 列全平台的对话，按最近活动倒序。筛选 `ownerUserId`、`taskId`、`since`、`until`（后两个作用在 `updatedAt` 上），可任意组合；没有 `users:manage` 是 `403`。
- 翻页给 `limit` 与 `cursor`：`cursor` 原样回传响应里的 `nextCursor`，为 `null` 表示没有更多了。自己编一个形状不对的是 `422`。
- `GET /conversations/{id}/transcript`、`.../transcript/ops`、`.../prompts`、`.../workspace/files`、`.../workspace/file` 对治理者同样放行；`GET /conversations` 与 `GET /conversations/search` 不放行——那是工作台，不是审计台。

### 附件

- 附件要先成为一个后端与模型都取得到的 **HTTP(S) 地址**，再作为 part 放进 `content`；正常路径是先把文件传到对象存储拿到地址（`POST /uploads/sign` 直传，见 §11）。只收 `kind: "url"` 的来源。
- 走直传拿地址不要求登记进素材库；agent 能不能用一个地址，判据是「它在这段对话里出现过没有」。
- 传不进来的附件不会让整条请求失败，而是在消息里原位变成一句 `[媒体不可用：…]`。

## 7. 产品资料查询 (Products)

`GET /products/{styleNo}` 按 **PDM 款号**精确查一个款，只读、零副作用。权限 `assets:read`。

- **`styleWms` 不是 `styleNo` 的别名。** 它是同一个款在 WMS 那边的编号，两套编码不通用；要按款去别的系统查东西时用它。
- 款号不存在、或已被上游标记删除，一律 `404`。

## 8. 合集 (Collections)

**权限**：`GET /collections`、`GET /collections/{id}` 需要 `collections:read`；`POST /collections`、`PATCH /collections/{id}`、`DELETE /collections/{id}` 需要 `collections:write`。

- **可见性**：合集有属主，只看得见自己的，别人的一律 `404`（读、改名、删除都是）。
- `GET /collections` 默认只列自己的，最近改动的排在前面；`?scope=all` 是治理者的全量视图，需要 `users:manage`，否则 `403`。翻页用 `limit` 与 `offset`。
- **合集只装对话，不挂需求单。** 需求单与对话之间是直接的那一条关系（见 §6）。
- **属主取自登录身份**，请求体里带 `ownerUserId` 一类字段一律 `422`。
- **删合集不带走对话**：对话那边只是 `collectionId` 变 `null`。

## 9. 创作需求单 (Tasks)

**权限**：`GET /tasks`、`GET /tasks/{id}` 需要 `tasks:read`；`POST /tasks`、`PUT /tasks/{id}`、`POST /tasks/{id}/publish`、`POST /tasks/{id}/confirm`、`POST /tasks/{id}/withdraw`、`DELETE /tasks/{id}` 需要 `tasks:write`。

- **可见性**：需求单没有属主，谁有 `tasks:read` 谁就看得见全部；看得见但不让改返回 `403`，`404` 只意味着这张单子不存在。
- `GET /tasks` 最近改动的排在前面。
- `PUT /tasks/{id}` 是**整体覆盖**，不是局部合并。
- **需求单不挂合集。** 单与对话之间是直接的那一条关系（见 §6）：一张单下面有几段对话，就是有人为它开过几段。
- **创建者取自登录身份**，请求体里带 `creatorUserId` 一类字段一律 `422`。

### 款号

- `styleNo` 只在创建请求体里，是主款号；`brief.styleNos` 是要拍的款全集，**主款排首位**。不给全集，服务端补成 `[styleNo]`；给了但首位不是主款 → `422`。
- `PUT` 改草稿不给 `styleNos` 会被补回原值，首位给错 `422`；已下发的不给 `styleNos` 等于动了冻结字段，返 `409`。
- `style` 是服务端按 `styleNo` 查产品资料后冻结的一份快照，**创建后不可改写**，没有端点能改。`PUT` 请求体里带 `styleNo` 或 `style` 一律 `422`。
- `style.brand` / `style.category` 上游没名字时是空字符串；`previewImageUrl` 在这个款没有产品图时也是空字符串。
- `previewImageUrl` 是首图转存到本仓对象存储后的地址。它只做列表封面，不进 `brief.referenceImages`。
- 创建时款号这一步的失败口径：产品资料里查不到这个款（或已被上游标记删除）→ `422`，`detail` 说明是哪个款号；服务端没配产品资料库或对象存储 → `422`；首图取不到、或转存写不进对象存储 → `5xx`，这次创建整体不落地。

### 状态机

`draft` →（publish）→ `published` →（confirm）→ `confirmed`；`published` 与 `confirmed` 都可以（withdraw）→ `withdrawn`。

- **`withdrawn` 是终态**：改不动、删不掉、也回不到 `published`。
- **走不通的流转一律 `409`**，不是 `422`。
- **只有 `draft` 能删**，下发之后 `DELETE` 返回 `409`。
- **`confirm` 在 `published` 与 `confirmed` 上都返 `200`**：前者把状态推到 `confirmed`，后者只多一个认领人；`draft` 与 `withdrawn` 上返 `409`。

### 认领

- `POST /tasks/{id}/confirm` 记下调用者认领了这张单。**一张单可以被多个人认领**，同一个人重复认领不多记一次。
- **认领人取自登录身份**，请求体与查询参数都不接收 user id。
- `assigneeUserIds` 按认领先后排序；`withdraw` 不清空它。
- 已是 `confirmed` 的单再被认领，`updatedAt` 不变，`GET /tasks` 的排序位置不动。
- `GET /tasks?claimedBy=me` 只回调用者认领过的单；`claimedBy` 只接受 `me`，其他值 `422`。

### 修改权限

- 草稿的 `PUT`、`DELETE` 与 `publish` 只有创建者本人或持 `users:manage` 的治理者能做，其他人 `403`。
- 下发之后的 `confirm`、`withdraw` 与 `PUT` 任何持 `tasks:write` 的人都能做。

### 冻结字段

`published` / `confirmed` 状态下，`PUT` 提交上来的 `brief` 与库里的逐字段比对：

- **仍可修改**：`title`、`priority`、`deadline`，以及 `brief` 里的 `durationSeconds`、`ratio`、`requirementDescription`、`referenceImages`、`referenceVideos`。`brief.styleNos` **不在**这几项里，下发之后动它是 `409`。
- **其余 `brief` 字段有任何一项与库里不同 → `409`**，并在 `detail` 里列出是哪几个字段。改法：先 `GET` 拿到当前这张单子，改动允许的字段，再整体 `PUT` 回来。
- `deadline` 在非草稿状态下**不能清空**（`422`）。

### 发布关卡

`POST /tasks/{id}/publish` 会拒绝以下情况：

- 不是 `draft` → `409`
- 调用者既不是创建者也没有 `users:manage` → `403`
- 没有 `deadline` → `422`
- `brief` 里 `requirementDescription`、`theme`、`referenceImages`、`referenceVideos` **四项全空** → `422`
- `deadline` 已经过去 → `409`

### brief

- `referenceImages`、`referenceVideos` **只收 `http://` 或 `https://`** 地址，别的 scheme `422`。本地文件先走 §11 的直传换成地址。

## 10. 爆款视频查询 (Inspirations)

`POST /inspirations/videos/search` 按款搜爆款视频，只读、零副作用。权限 `assets:read`。

- **`styleWmsList` 收的是 WMS 编号，不是 PDM 款号。** 两套编码不通用，传成款号搜不到东西。拿 `GET /products/{styleNo}` 响应里的 `styleWms` 来喂它。
- **排序与截断都在服务端做**：换一个 `sortBy` 是换一批样本，不是把同一批本地重排。
- `category` 是**平台口径的英文类目**，和产品资料接口里的 PDM 品类不是一套，两边不互相翻译。

## 11. 素材上传 (Assets)

上传分两步：`POST /uploads/sign` 领一个 `assetId` 和一条限时直传地址，浏览器直接把字节 PUT 到对象存储，再 `POST /assets/{assetId}` 登记。外部地址上的东西（产品图、爆款库的视频）走 `POST /assets/import` **转存**进本仓对象存储再登记。

**权限**：`POST /uploads/sign`、`POST /assets/{assetId}`、`POST /assets/import` 需要 `assets:write`；`GET /assets`、`GET /assets/{assetId}` 需要 `assets:read`。

- **素材是全公司共用的**：谁有 `assets:read` 谁就看得见全部，`creatorUserId` 只是查询维度，不是访问边界。
- `GET /assets` 最近登记的在前。
- **`upload.headers` 必须原样带上。** `Content-Type` 被签进了签名里，换一个值去 PUT 会被对象存储拒掉（`403`）。
- **`expiresAt` 之前必须把上传发起**（有效期一小时）。过期了就重新调一次 `sign`，会拿到一个新的 `assetId`。
- **登记之前那个 `assetId` 还不是一份素材**，`GET /assets/{id}` 会 `404`。
- **登记可以重复调**：第二次返回同一行（还是 `201`）。
- content-type 只收 `image/jpeg`、`image/png`、`image/webp`、`video/mp4`、`video/quicktime`。别的类型在 `sign` 那一步就 `422`。
- 大小上限：图片 16MB、视频 512MB。**超限是在登记那一步才拒（`422`）**，字节已经传进桶里的随后会被清理。
- **图片尺寸**：短边 ≥ 300px、长边 ≤ 6000px。直传时**尺寸由客户端在 `sign` 时报**（`width` / `height`，传图必填，传视频不用给），不合格当场 `422`；转存时尺寸由服务端实测。
- **传上来之前就登记是 `409`**，用没人签过的 `assetId` 去登记同样是 `409`。
- **`url` 是由对象 key 拼出来的，不是存的。不要把 `url` 当作素材的身份**，`id` 才是。
- 转存的 **`assetId` 由源地址算出来**：同一个地址转存多少次都是同一行，第二次连请求都不往上游发；上游原地换了图不会跟着更新。
- 转存的类型、大小、尺寸全是**实测**的，上游报什么不作数。取不回来、类型不收、尺寸不合格都是 `422`。
- 转存**不跟随重定向**：`3xx` 直接当取不回来。
- **能登记不等于 agent 能用。** agent 工具只接受「这段对话里出现过」的地址（见 §6 附件）。
