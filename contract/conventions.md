# 跨端合同约定 (API Conventions)

> HTTP 端点、端点权限与数据形状以 [`openapi.json`](openapi.json) 为准，生成流程见 [开发约定](../AGENTS.md)。本文补充跨端消费语义、认证、动态错误与 WebSocket 约定；领域术语和不变量见 [CONTEXT.md](../docs/CONTEXT.md)。

## 1. 部署与路由路径

- **路径代理**：前端浏览器代码只调用同源的 `/api/*`。在开发环境 (dev) 由 Vite Proxy 代理，在生产环境 (prod) 由 Nginx/Ingress 反向代理，将 `^/api` rewrite 掉后直达后端根路径（前端调用 `/api/users/me`，实际到达后端为 `/users/me`）。
- **保持同源**：`/api` 由反向代理转发，不用 `3xx` 把浏览器重定向到另一个 Host。会话 Cookie 不设置 Domain；同一次登录与 API 访问使用同一主机名，不混用 `localhost`、`127.0.0.1` 和局域网地址。
- **WebSocket 代理**：支持 `/api/ws` 的 Upgrade，并保留浏览器 Origin。后端以 Origin 与 Host 核对同源，代理应保留外部 Host，或显式配置允许的 Origin；不能通过删除 Origin 绕过校验。

## 2. 双主体认证 (Dual Principals)

- **浏览器会话**：使用后端设置的 HttpOnly Cookie `iclip_session`，浏览器自动携带；前端 JavaScript 不读取、存储或转发这个会话凭证，也不代持 API Key。
- **SSO 回调票据**：前端落地页读取 `jwt_token`（兼容 `jwt`），再通过同源 `GET /auth/sso/callback?jwt=...` 交给后端验证并建立上述会话，随后以 replace 导航离开票据 URL。票据不作为后续 API 的认证头，不存入浏览器持久存储。
- **登录态**：以 `GET /users/me` 为准；`401` 表示未登录或会话失效，前端不从 SSO 票据或本地标记推断已登录。
- **机器端调用方**：基于 Bearer Token 的无状态调用（请求头携带 `Authorization: Bearer <token>`）。明文形态不构成合同，服务端按哈希查表认证，不从前缀判断。
  - 明文仅在成功创建的响应中返回一次；权限语义见 [CONTEXT.md](../docs/CONTEXT.md)。
- **两种凭证同时出现**：请求带 `Authorization: Bearer` 时只按 Bearer 认证，不看会话 Cookie；Bearer 无效即按未登录处理，不回落到 Cookie。WebSocket 握手同一规则。
- **端点权限**：每个 HTTP 操作的凭证与权限看 `openapi.json` 里该操作的 `security`。安全方案只有 `SessionCookie`（Cookie `iclip_session`）与 `BearerToken`（HTTP Bearer）；`security` 列出的各项之间是「或」，方案下的 scopes 就是所需权限名，列出多个须同时具备；两个方案都是空数组表示登录即可；没有 `security` 的操作公开；`POST /auth/logout` 只列 `SessionCookie`，只能凭会话登出。权限词汇是合同里的 `Permission` 组件，授予权限的请求字段按它校验，响应里的权限集是字符串数组、不随词表收紧；角色语义见 [CONTEXT.md「角色」](../docs/CONTEXT.md#术语)。条件性权限（如 §7 的 `?scope=all`）、行级归属、WebSocket（§5）与替人办事不在 `security` 里，以本文各节为准。
- **替人办事**：持 `users:act_as` 的 API key 在 `POST /conversations`（`userName`）、`POST /tasks`（`userName`）、`POST /conversations/{id}/prompts`（`user_name`）与 `POST /generations/*`（`user_name` / `userName`）的请求体里指名，那次请求的属主、创建者、认领人就是那个人，语义见 [CONTEXT.md「API Key」](../docs/CONTEXT.md#术语)。浏览器会话在这些字段里只能写自己的用户名，写别人是 `422`。

## 3. 数据载荷与格式 (Payload Formatting)

- **命名**：业务 HTTP API 的请求体、查询参数和响应使用 camelCase。既有例外是 SSO `authorization_url`、注册接口的用户状态字段、§5 的 Transcript 协议字段，以及 §11 里视频提交与视频任务查询这一对端点（它们是上游视频异步接口的原样镜像）；消费者按生成合同取名，新业务端点不沿用这些例外。
- **时间**：时间戳使用 ISO 8601 UTC。
- **排序**：列表一律按建立时间（`createdAt`）倒序，同一时刻按资源 ID 倒序兜底；游标分页续的就是这个排序键。列表位置因此只随新建改变，后续操作不会让条目换位。
- **标识**：资源 ID、游标与协议 ID 按各自合同使用，不从 URL、显示名称或序号推导资源身份。客户端 `prompt_id` 是消息幂等键；对话和需求单 ID 可由调用方提供，运行 ID 由服务端发放，轮 ID 则是 Transcript 内的顺序标识；幂等语义见 [CONTEXT.md 不变量 8](../docs/CONTEXT.md#不变量)。

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

请求结构校验失败（`422`）用同一个字符串信封：`detail` 是一句 `<字段路径>: <原因>`，字段路径形如 `shot.timeline[0].image_indexes`，报在请求体自身的只有原因。一次请求只给第一条，后面几条通常是同一处问题的连带结果。生成任务的业务失败通过任务状态与 `errorCode` / `errorMessage` 表达，HTTP 受理成功不代表生成成功。

## 5. Agent 对话 (Transcript)

agent 对话使用 kimi code 的 Transcript 协议，HTTP 端点挂在对话下面，各端点的权限见 [`openapi.json`](openapi.json) 的 `security`（§2）；WebSocket 建连需 `agent:run`。写入限属主，治理者可读取其他用户的对话。

### 字段名：这一面照协议原样，不套 §3

Transcript 沿用协议字段，不统一改名；HTTP 形状仍从 OpenAPI 生成：

- **信封 snake_case**：`agent_id`、`has_more_older`、`has_more`、`latest_seq`、`prompt_id`、
  `since_seq`、`before_turn`、`after_turn`、`page_size`。
- **里面装的实体与操作 camelCase**：`turnId`、`stepId`、`frameId`、`toolCallId`、`hasMoreOlder`。
- **协议字段只增不改**：已镜像的字段不改名、不改类型、不删；新字段只能是可选项，服务端模型、前端 vendored schema、实时投影、历史重建与金样在同一个 PR 落齐；前端 schema 会剥掉未声明的字段，金样测试要对新字段做存在性断言。

### 发消息

`POST /conversations/{id}/prompts`，体是 `{prompt_id, content, user_name?}`。

- `prompt_id` 由客户端铸（乐观气泡靠它认领服务端回来的那条）。同一段对话里重发同一个 id
  返回已有那条，不会多起一次运行；换一段对话用同一个 id 是 `409`。
- `user_name` 是这条消息替谁发的，运行带着它、工具把它发给上游落表对账；它不是身份，
  不参与授权。API key 调用方必填，缺失是 `422`，给什么用什么。浏览器会话可省略，服务端填
  登录用户名；给了就必须等于登录用户名，否则 `422`。重新生成沿用原消息的值。
- 答复是这条消息的记录：这段对话空着就 `status: "running"`，正忙就 `"queued"`。

### 读

- `GET /conversations/{id}/transcript` 默认取最新轮次；`before_turn` 向旧翻，`after_turn` 取指定轮之后的内容，两者不能同时给。`has_more` 始终表示当前页之前还有更旧轮次，不是向新翻页的结束标志。
  `agent_id` 默认 `main`；给子代理的 id（工具卡 `agentRefs` 里那个）就读它那条流，`agents` 名册与主页同一份。不属于这段对话的 id 是 `404`，带路径分隔符的是 `422`。
  响应顶层带两个信封字段（不在 `meta` 里，那是协议形状）：`title` 给首屏显示，`owner_user_id` 让会话页判断这是不是自己的对话、要不要只读。金样里没有 `owner_user_id`（它由 REST 端点贴上，引擎不认识对话表），客户端按可选解析。
- `GET /conversations/{id}/transcript/ops?since_seq=` 补断线期间漏掉的批次，`agent_id` 同上。
  `complete: false` 表示要的批次已经出了窗口，整页重拉。
- `GET /conversations/{id}/prompts` 当前排程：`{active, queued}`。
- `GET /conversations/{id}/status` 只回一个 `status`，给轮询的调用方用：`running` 含排队，
  `awaiting` 是不给审批决定就不会往下走，`completed` / `failed` / `aborted` 是上一轮的结果，
  `idle` 是从没跑过。
- 轮头部与用户文本块都带 `content`，就是发消息那串 part 原样、次序不动。
- 图和视频只在 `content` 里，不另发附件实体，快照与分页里也没有 `attachments`。
- 压缩不删除可见的历史轮次；压缩提示属于步骤内的块，不单独占一轮。模型窗口与完整历史的区别见 [CONTEXT.md](../docs/CONTEXT.md)。

### 停止、插话、审批、重新生成

- `POST /conversations/{id}/prompts/{prompt_id}:abort`：排队的直接撤，在跑的发取消让它自己
  收尾。已经结束的是 `409`。
- `POST /conversations/{id}:abort`：停整段对话——排着的**全部**撤掉，在跑的那条发取消。什么
  都没在跑照样是 `204`。**别拿上一条逐条撤**：撤到一半在跑的那条结束了，还没撤到的队首会被
  顶上来接着跑。
- `POST /conversations/{id}/prompts:steer`，体 `{prompt_ids}`：把排队中的几条插进正在跑的
  那一轮，不必等它跑完。没有在跑的运行是 `409`。
- `POST /conversations/{id}/turns/{turn_id}:regenerate` 只重跑空闲对话的最后一轮。客户端使用轮头部的 `t{N}`，不可按当前页面位置自行编号；忙碌或非末轮返回 `409`。旧运行记录保留，可见末轮由新运行替代并复用轮 ID；替代前会收到 `items.remove`。
- 重新生成可省略整个请求体；省略 `content` 使用原输入，提供则替换。提供 `prompt_id` 时沿用发消息的幂等语义，省略时由服务端生成。
- `POST /conversations/{id}/interactions/{interaction_id}` 提交审批决定，记录后返回 `204`；同批决定齐备后服务端续跑。仍在等待的审批重复同值幂等，改值返回 `409`；已不在等待的卡返回 `404`。

### 订阅

`WS /ws` 一条连接订阅多段对话，经过同源代理时使用 `/api/ws`。WebSocket 帧不在 OpenAPI 中：标准 Transcript 实体与操作消费 [vendor](../web/src/shared/transcript/vendor/README.md)，本项目的连接帧 schema 位于 [connection.ts](../web/src/shared/transcript/connection.ts)。后端实际发出的帧序列与 REST 一页存成金样 [transcript/](transcript/)，覆盖 `transcript.reset` / `transcript.ops`，两端形状对不上会在其中一边先红，生成与解析见[测试规范](../docs/test-design.md#1-按行为选择测试层)；全局帧与文件变更帧没有金样，前端 schema 照后端 [wire.py](../server/src/iclip/platform/transcript/wire.py) 手写。

- 握手：服务端先发 `server_hello`（客户端只取 `heartbeat_ms`），客户端**每段对话各发一帧**
  `subscribe_v2`，体里 `session_id` 是对话 id，`transcript` 是按 agent 给的档位，带
  `transcript_since` 就是补批。表里每个 agent 各自订阅、各自水位，同一帧里再发就是更新；
  出现不属于这段对话的 agent 时整帧拒绝，`ack` 带 `code: 404`，订阅不变。协议里的
  `client_hello` 我们不收。
- 退订一段发 `unsubscribe_v2`（体里 `session_id`）；带 `agent_ids` 只退列出的 agent；关连接就是全退。
- **订阅逐段核权**：看不见的对话与不存在的对话一个待遇——回执 `ack` 的 `payload.not_found` 里
  带上它，整条连接不动（其余对话照旧）。建连时只核登录与 `agent:run`。
- 对话帧带 `session_id`，客户端按它分流；Transcript 水位按对话各记一份。连接级握手与心跳不属于某段对话。
- 服务端每 10 秒发一帧 `ping`；连着两个周期没有收到**任何**入站帧就断开（`1001`）。
- 每段对话第一次订阅收到一帧 `transcript.reset`（档位是 `off` 时一帧都不发，见下），其后是
  `transcript.ops`。**reset 里的 `seq` 会无条件覆写客户端本地水位**（不是取较大值）——进程重启
  后批次号从 1 重来，靠的就是这条。
- 不在显式允许列表中的跨域升级请求关闭（`1008`）；浏览器同源请求通过，机器端无 Origin 的请求仍须认证。
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

这几帧**都不看订阅**：发给属主当时连着的每一条连接，一段都没订也收得到；治理者的连接收全平台每一段对话的这几帧。

| 帧 | 体 | 什么时候发 |
|---|---|---|
| `session.meta.updated` | `{session_id, title}` | 标题变了（自动起名或用户改名） |
| `event.session.work_changed` | `session_id` 在信封上，payload `{busy, pending_interaction, last_turn_reason}` | 对话运行活动发生变化 |
| `event.generation.changed` | `session_id` 在信封上（任务没有来源对话时省略），payload `{id, kind, operation, status, shot_index, metadata}`；`shot_index` 是视频的镜头组编号（同 `GenerationOut.shotIndex`），`metadata` 是调用方自带的标签原样带出，两者为空时省略 | 生成任务的业务状态每跳一格：`pending` / `submitting` / `submitted` / `completed` / `failed` |

- **发给属主和治理者**，不是见者有份：连接归谁由它握手时的主体定；持 `users:manage` 的连接收全平台的帧。权限按握手时快照，吊销后要重连才生效。
- `event.session.work_changed` 的 `last_turn_reason` 只在 `busy: false` 的那几帧上有：帧一律
  `exclude_none`，没有结局时那一项整个不出现（列表行上是 `null`，见 §6）。
- **都是易失通知**，客户端据此更新列表；断线期间的变化不补发，重连后须重拉列表，从 `ConversationOut.title` 与 `activity` 对齐当前事实。
- `event.generation.changed` 不带结果地址，只说哪条任务跳到了哪个状态；收到就重拉 §11 的列表。`kind`、`operation` 与 `status` 的词汇同 `GenerationOut`，列表接口是事实源，客户端保留轮询兜底。对话行上的 `activity.videoGeneration` 也靠它推动：帧上没有汇总值，收到本对话的视频帧（出片、编辑段、合成都是）就重拉 §6 的列表。
- 一条跑完接着起下一条会先发 idle 再发 busy。

#### 文件订阅

照 kimi 的 `watch_fs_add` / `watch_fs_remove` / `event.fs.changed`：文件变动是**会话事件，按订阅投递**，与 transcript 订阅各管各的。

| 帧 | 方向 | 体 |
|---|---|---|
| `watch_fs_add` / `watch_fs_remove` | 客户端 → 服务端 | `{ id, payload: { session_id, paths, recursive? } }`；回执 `ack`，payload `{ watched_paths, current_count }`；订看不见的对话 `code` 为 `40401` |
| `event.fs.changed` | 服务端 → 客户端 | `session_id` 在信封上，payload `{ changes: [{ path, change, kind }], coalesced_window_ms }`；`change` 为 `created` / `modified` / `deleted`，`kind` 恒为 `file`，`coalesced_window_ms` 恒为 `0` |

- 订的是文件就要路径一样；订的是目录，`recursive` 为假只看直接子项，为真看整棵。空串是工作区根：`recursive` 为真就是整个工作区。
- 帧上不带版本与写入者：收到就重读那个文件，`version` 在文件上；是不是自己刚写的由客户端记自己写回拿到的版本号来判。
- 工具与面板写文件都会触发通知。通知易失，重连后重拉文件列表对齐。
- 能订、能收的范围同全局帧：属主自己的连接，和持 `users:manage` 的治理者连接；别的普通用户订它是 `40401`。

## 6. 对话 (Conversations)

- 对话 id 是 UUID，请求体、路径和 §5 的 WebSocket 帧带不带横线都收（`e1e53ab6ec97...` 与 `e1e53ab6-ec97-...` 指向同一段）；服务端一律以带横线的规范写法答复与存储，WS 帧上的 `session_id` 同样只发规范写法。不是 UUID 的写法在 REST 上是 `422`，在 WS 上与看不见的对话同一个待遇（订阅进 `ack` 的 `not_found`，原样带回问的那个串；文件订阅是 `40401`）。
- `POST /conversations` 的 `id` 可由调用方给，缺省由服务端生成。带 `id` 重发同一个值**不新建第二段对话**，答复已有那一段并把状态码降为 `200`（新建仍 `201`）；这个 id 属于别人的对话时是 `404`，与按 id 读别人的对话一致。对话删除后 ID 仍保留，任何人重用都返回 `404`；新对话必须换一个 ID。
- `GET /conversations` 返回自己的侧栏拓扑：合集及各自第一页对话、未分组合的第一页对话。合集与对话都按 §3 的排序规则，空合集也保留。
- 侧栏只带最近建立的 100 个合集；更早建的合集连同其中的对话不在这份响应里，也没有截断标记，合集全量走 §7 的 `GET /collections`。
- **两个数字是真总数**：`ungroupedCount` 与每个合集的 `conversationCount`，与这一页给了几条无关。
- `GET /conversations`、`GET /conversations/ungrouped`、`GET /conversations/by-collection/{id}` 都收 `state`，四值 `all`（默认）/ `open` / `done` / `running`。`done` 是属主标了收尾（`completedAt` 非空）、`open` 是没标，两者互补合起来就是 `all`；`running` 是此刻有轮次在跑（含等审批），与前两者不同层、可以和它们交叉。`ungroupedCount` 与每个合集的 `conversationCount` 按同一个筛选算；审计接口的 `state` 同一口径。
- 往下滑加载更多：`GET /conversations/ungrouped?cursor=` 与 `GET /conversations/by-collection/{collectionId}?cursor=`，都返回 `{ items, nextCursor }`。`cursor` 原样回传上一页的 `nextCursor`（把它当不透明字符串），为 `null` 表示没有更多了；形状不对是 `422`。
- **`by-collection` 不区分「合集不存在」「合集是别人的」「合集是空的」**，三种都给一页空的；这是只列自己对话的工作台接口。
- `GET /conversations/search?q=` 按标题搜自己的对话，返回扁平列表；`GET /conversations/by-task/{taskId}` 列自己在这张单下的尝试，最后一次排在最前。两者都按 §3 的排序规则。
- `lastRunId` 只标识最近一次运行，不能作为续读地址；刷新与重连按对话 ID 和 Transcript 水位恢复（§5）。
- `activity` 的领域语义见 [CONTEXT.md](../docs/CONTEXT.md)，变化通过 §5 的全局帧通知。
- **标题服务端自动起，只成功写入一次**：配置标题模型时，轮次结束后尝试起名；
  用户自己改过名（`PATCH`，或者开对话时就给了 `title`）的一律不碰。起不出来就还叫默认名，下一
  轮跑完再试，不报错。改名与自动起名都会发一帧 `session.meta.updated`（见 §5 全局帧）。
- 会话页首屏的标题与属主在 `GET /transcript` 响应的顶层 `title` 与 `owner_user_id` 上——**不在 `meta` 里**（那是协议形状，
  加字段会被客户端静默丢掉）。标题之后的变化只走推送，不用轮询。
- 普通用户访问其他人的对话返回 `404`。按需求单列尝试只列自己的；治理者读权限见下文。
- `PUT /conversations/{id}/workspace/file` 整份覆盖一个文件，体是 `{ path, content, expectedVersion }`，答复形状同 `GET .../workspace/file`。
  - **只有属主能写**：看不见的对话仍是 `404`，治理者看得见但写入是 `403`。
  - `expectedVersion` 是读到那一份的版本号，对不上是 `409`（文件不存在时任何版本都对不上，同样 `409`——不替调用方新建）。写成功后版本加一。
  - `path` 必须是文件列表里那个写法（规范形式），`/video_shot.json` 这种是 `422`。
  - `video_shot.json` 复用镜头表形状校验，不合法返回 `422`。面板写入不校验地址来源，也不把地址登记成对话素材；用户要让 agent 使用新地址，须以附件提交。
  - `video_shot.json` 由 `write_video_shots` 整份交付，每组 `image_urls` 支持 0–30 张；工具提交与文件写回共用这条上限，超限分别返回重试提示与 `422`。
  - `review.md` 是 agent 收尾时写下的需要人工复核的事项，纯文本一条一行，由 `write_file` 写入，不做形状校验。它是可选交付物：没有需要复核的事项时 agent 不写这份文件，取它得到 `404`；调用方把「文件不在」与「内容为空」都按没有复核事项处理。

### 分叉

`POST /conversations/{id}:fork` 从看得见的某段对话的第 `turn` 轮岔出一段新对话，归调用者所有，语义见 [CONTEXT.md「对话」](../docs/CONTEXT.md#术语)。它只要 `agent:run`（写自己）加上对源的读可见性：**人人能分叉自己的，治理者能分叉任何人的，包括墓碑**。副本的 id 由服务端铸，不收调用方铸的 id。

- 体是 `{ turn, title?, agentId?, collectionId? }`。`turn` 从 1 数，这一轮含在副本里；`agentId` 不给就沿用源的，给了就换一个用于对照试跑；`title` 不给就是源标题加「（分叉 · 第 N 轮）」，并按用户自定义记，自动起名不再碰它。
- 源看不见是 `404`，`turn` 越界或源从没跑过是 `422`，源还有没跑完的消息（在跑、等审批或排队）是 `409`。
- 答复形状同 `POST /conversations`，行上多两个字段：`forkedFrom`（源对话 id）与 `forkTurn`（分叉自第几轮），不是分叉来的对话两个都是 `null`。副本再分叉时 `forkedFrom` 指它的直接上游。会话页首屏另从 `GET /transcript` 的顶层拿 `forked_from` 与 `fork_turn`（照 §5 的协议命名，与 `owner_user_id`、`deleted_at` 同一处）。
- **拷过去的**：截到第 `turn` 轮的对话历史、工作区文件（版本从 1 起）、素材台账。**不拷的**：运行记录（副本拿原 run id 回源查终态与子代理）、源的需求单归属（挂上就等于替别人认领）。
- **出片记录不拷，副本继承**（哪些算继承见 [CONTEXT.md「继承」](../docs/CONTEXT.md#术语)）：读得到副本的调用者 `GET /generations?conversationId=副本` 时连同继承的一起列出，`before` 翻页照常；读不到副本就只按属主列，不另报 `404`。继承来的记录可以下载、可以当基底去剪（编辑段的来源可以是继承来的那条，见 §11「来源与原作」），剪出来的编辑段与合成记在副本名下。`GET /generations/{id}` 与 `GET /generations/video/{task_id}` 仍只按属主。
- 继承来的轮 `:regenerate` 返回 `404`；副本上发过一条新消息之后，那一轮照常可重新生成。源对话里跨多次运行的一轮（审批后恢复、续跑）在副本里会拆成多轮显示。
- 媒体字节不复制：两边的地址指向同一批对象，编辑只会按新任务 id 产出新地址，不覆盖也不删除。
- 副本不进审计报表（见 §12）。

### 两处归属

- 归属关系见 [CONTEXT.md](../docs/CONTEXT.md)。`taskId` 用 `PUT .../task` 改，`collectionId` 用 `PUT .../collection` 改，给 `null` 就是摘掉。
- 需求单下的尝试按对话 `createdAt` 排，事后补挂不改变这个次序。
- 两处都给不存在的 id 是 `422`。

### 收尾标记

- `PUT /conversations/{id}/completion` 收 `{ "completed": true | false }`，标记或取消属主对这段对话的收尾判断，答复整行。标记时刻在 `completedAt` 上，没标过是 `null`。
- 只有属主按得动。属主发消息（§5）或在这段对话下提交出片（§11）时 `completedAt` 回到 `null`；语义见 [CONTEXT.md「对话」](../docs/CONTEXT.md#术语)。
- 标完照旧在列表里，位置不变（§3），只是 `state=done` 筛得到它。

### 治理者复盘

治理者使用 `users:manage` 扩大读取范围，操作本身所需的 `agent:read` / `agent:run` 仍须具备。其他人的改名、换归属、删除、发消息路径返回 `404`；工作区覆盖写入返回 `403`。

- `GET /conversations/audit` 列全平台的对话，排序按 §3。筛选 `ownerUserId`、`taskId`、`since`、`until`（后两个作用在 `createdAt` 上，与排序同一列；§12 的报表按各指标自己的事件时刻分期，同一段时间两边不是同一批对话）、`state`（四值同上）与 `deleted`（`live` 缺省只看活着的，`deleted` 只看属主删掉的，`all` 都看），可任意组合。
- 响应带两个真总数，都不随翻页变：`total` 是当前筛选下一共几段，`runningTotal` 是同一组属主 / 需求单 / 时间 / 删没删筛选下此刻在跑的几段（不受 `state` 影响）。
- 已删对话是墓碑：行上 `deletedAt` 非空，只有带 `deleted` 的审计列表能列出它。治理者按 id 读它的 transcript、工作区文件与订阅都照常，`GET /transcript` 顶层多一个可选 `deleted_at`；属主与其他人读它都是 `404`；对话自身的写路径（改名、换归属、再删、发消息、改工作区文件）对谁都关着，一律 `404`，只有治理者对自己墓碑的工作区覆盖写入是 `403`（这个口子先读整行再判属主，分得出「看得见但不能改」；其余写路径是带属主条件的单条更新，分不出）。生成任务的 `conversationId` 只是归档标签，不校验对话，见 §11。
- 翻页给 `limit` 与 `cursor`：`cursor` 原样回传响应里的 `nextCursor`，为 `null` 表示没有更多了。自己编一个形状不对的是 `422`。
- `GET /conversations/{id}/transcript`、`.../transcript/ops`、`.../prompts`、`.../status`、`.../workspace/files`、`.../workspace/file` 允许治理者跨属主读取；`GET /conversations` 与 `GET /conversations/search` 对治理者也只列自己的对话。

### 附件

- 附件通过 `content` 的图片或视频 part 提交，只收具有主机名的 HTTP(S) 地址；其他地址返回 `422`。本地文件先直传换成公开地址（§10）。
- 附件提交会登记对话素材；普通正文 URL 与面板文件内容都不会代替这一步，精确匹配与类型规则见 [CONTEXT.md](../docs/CONTEXT.md)。
- 图片输入保留原图引用；仅支持缩放的地址附带缩放像素，其他图片及视频保留媒体引用，内容由相应工具读取。提交成功不保证外部 URL 在后续读取时可用。

## 7. 合集 (Collections)

- 普通用户访问其他人的合集返回 `404`；治理者可读、改名和删除其他人的合集，不能据此取得其中对话的写权限。
- `GET /collections` 默认只列自己的，排序按 §3；`?scope=all` 是治理者的全量视图，需要 `users:manage`，否则 `403`。翻页用 `limit` 与 `offset`。
- **属主取自登录身份**，请求体里带 `ownerUserId` 一类字段一律 `422`。

## 8. 创作需求单 (Tasks)

- **可见性**：需求单没有属主，谁有 `tasks:read` 谁就看得见全部；看得见但不让改返回 `403`，`404` 只意味着这张单子不存在。
- `GET /tasks` 排序按 §3，翻页给 `limit` 与 `cursor`，返回 `{ items, nextCursor, total }`：`cursor` 原样回传上一页的 `nextCursor`（不透明字符串），为 `null` 表示没有更多了，形状不对是 `422`；`total` 是当前筛选下一共几张，不随翻页变。`ids` 可重复给，按 id 集合批量读取，与其他筛选一样只是条件，一次最多 100 个，多了是 `422`。
- `PUT /tasks/{id}` 是**整体覆盖**，不是局部合并。
- **创建者取自执行主体**：登录身份，或持 `users:act_as` 的 key 在 `userName` 里指名的人（见 §2）。请求体里带 `creatorUserId` 一类字段一律 `422`。
- `POST /tasks` 的 `id` 与 `status` 可由调用方给：`id` 缺省由服务端生成，`status` 只接受 `draft`（缺省）与 `published`。带 `id` 重发同一个值**不新建第二张单**，答复已有那一张并把状态码降为 `200`（新建仍 `201`）。两项只在创建时接受，`PUT` 带上它们是 `422`。

### 创作输入与商品

- `POST /tasks` 与 `PUT /tasks/{id}` 使用同一份 `inputs` 结构。任务外层沿用 camelCase，`inputs` 内部使用 snake_case，与持久化 JSONB 一致；具体字段由 OpenAPI 定义。
- `inputs` 是唯一的创作需求来源。创建不再隐式查询产品目录或转存商品图，调用方明确提供商品款号、名称、品牌、品类、颜色和图片；本地文件先走 §10 的上传流程。
- `inputs.products` 是这张单要拍的商品列表，1 到 20 款，款号不重复。列表里的款号及其顺序在创建时定下，之后不能增减、调换或更换；草稿允许补充每款的名称、品牌、品类、颜色和图片，发布后整个列表冻结。
- 商品图片用于商品展示，参考图片分别归入模特、穿搭、道具类别，不根据 URL 或上传顺序推断用途。
- `task_id` 使用需求单自身 ID，`generation_id` 对应一次创作尝试的 Conversation ID，二者不重复保存在 Task 的 `inputs` 中。

### 状态机

`draft` →（publish）→ `published` →（confirm）→ `confirmed`；`published` 与 `confirmed` 都可以（withdraw）→ `withdrawn`。

- **`withdrawn` 是终态**：改不动、删不掉、也回不到 `published`。
- **走不通的流转一律 `409`**，不是 `422`。
- **只有 `draft` 能删**，下发之后 `DELETE` 返回 `409`。
- **`confirm` 在 `published` 与 `confirmed` 上都返 `200`**：前者把状态推到 `confirmed`，后者只多一个认领人；`draft` 与 `withdrawn` 上返 `409`。

### 认领

- `POST /tasks/{id}/confirm` 记下调用者认领了这张单。**一张单可以被多个人认领**，同一个人重复认领不多记一次。
- **对话挂上需求单就是认领**：`POST /conversations` 带 `taskId`，或 `PUT /conversations/{id}/task` 给非空 id，都以对话属主认领那张单，`published` 推到 `confirmed`；单子是 `draft` 或 `withdrawn` 时挂得上但不认领、不报错。摘掉对话不清认领记录。
- **认领人取自执行主体**，请求体与查询参数都不接收 user id。
- `assigneeUserIds` 按认领先后排序；`withdraw` 不清空它。
- 已是 `confirmed` 的单再被认领，`updatedAt` 不变。
- `GET /tasks?claimedBy=me` 只回调用者认领过的单；`claimedBy` 只接受 `me`，其他值 `422`。

### 修改权限

- 草稿的 `PUT`、`DELETE` 与 `publish` 只有创建者本人或持 `users:manage` 的治理者能做，其他人 `403`。
- 下发之后的 `confirm`、`withdraw` 与 `PUT` 任何持 `tasks:write` 的人都能做。

### 冻结字段

`published` / `confirmed` 状态下，`PUT` 提交的 `inputs` 与持久化内容按业务字段比较：

- **仍可修改**：`title`、`priority`、`deadline`，以及 `inputs.video_spec` 的 `resolution`、`aspect_ratio`、`duration_seconds`，`creative_requirement`、分类参考图片和参考视频。
- **冻结**：商品信息，以及 `video_spec` 的 `platform`、`video_type`、`content_type`。改变冻结字段返回 `409`，响应列出具体路径。
- `deadline` 始终可选，任何状态下都可以清空。更新前先读取完整需求单，保留不能修改的字段，再整体 `PUT` 回来。

### 发布关卡

`POST /tasks/{id}/publish` 会拒绝以下情况：

- 不是 `draft` → `409`
- 调用者既不是创建者也没有 `users:manage` → `403`
- 创作要求、商品图片、三类参考图片与参考视频全部为空 → `422`
- 填了 `deadline` 而它已经过去 → `409`；没填期限不拦

### 素材地址

- 商品图片、参考图片和参考视频只接受具有主机名的 HTTP(S) 地址；空参考视频使用 `null`。本地文件先走 §10 的直传换成地址。

## 9. 爆款视频查询 (Inspirations)

`POST /inspirations/videos/search` 按款搜爆款视频，只读、零副作用。

- `styleNos` 使用 **PDM 款号**。WMS 编号只在数据入库时用于对齐数仓，不出现在接口上。
- 只返回可下载的自家副本地址（`videoUrls`），按 `sortBy` 降序。**排序与截断都在服务端做**：换一个 `sortBy` 是换一批样本，不是把同一批本地重排。
- **绝大多数结果是替身。** 自己有爆款视频的款只占少数，因此本款没有视频时按「同品牌同类目 → 同类目」逐级放宽。`matches` 逐款给出 `exact` / `sameBrandCategory` / `sameCategory` / `none`；除 `exact` 外，属于这个款的链接都不是它自己的视频。
- **`filters` 不影响降级。** 五个下限只筛最终结果；门槛把本款的视频筛空，不等于这个款没有视频，仍判 `exact`，不去找替身。
- 未精确命中本地快照的款，在 PDM 款目录中查不到、或缺少品类／品牌归属时，落 `none`，不是 404。全部落空时返回空 `videoUrls`，仍是 `200`。
- 视频数据是随迁移灌入的一次性快照，不自动更新；请求不访问原始视频库。同类匹配所需的款归属从外部 PDM 款目录读取。已知边界见 [CONTEXT.md](../docs/CONTEXT.md)。
- 未配置 PDM 款目录库时接口照常提供，但降级整级失效，未精确命中的款一律 `none`；这属于能力缺失，服务启动时会告警。

## 10. 上传 (Uploads)

上传分两步：`POST /uploads/sign` 领一个 `uploadId` 和一条限时直传地址，浏览器直接把字节 PUT 到对象存储，再 `POST /uploads/{uploadId}/confirm` 确认，拿回 `{ url, contentType, sizeBytes }`。服务端不登记上传，语义见 [CONTEXT.md「上传」](../docs/CONTEXT.md#术语)。

- **`upload.headers` 必须原样带上。** `Content-Type` 与审计用的 `x-oss-meta-*`（上传者、API key）都签进了签名里，少一个、改一个去 PUT 都会被对象存储拒掉（`403`）。
- **`expiresAt` 之前必须发起上传**。过期后重新调用 `sign`，会拿到新的 `uploadId`。
- 类型、大小和图片尺寸边界以 [上传规则](../server/src/iclip/domains/uploads/models.py) 为准。直传图片在 `sign` 时校验客户端声明的宽高；`confirm` 按桶中对象校验类型和大小，不合格返回 `422`，字节仍留在桶里。
- 桶内没有对应对象时 `confirm` 返回 `409`；签名成功本身不代表上传完成。
- **`confirm` 可以重复调**：每次都按桶里的对象重新回答，结果一样。
- 上传不会登记对话素材；把地址作为附件提交后，agent 才能按对话素材规则引用（§6）。

## 11. 媒体生成 (Generations)

四条提交地址：`POST /generations/video`（出片）、`POST /generations/image`（图片）、`POST /generations/video-edits`（编辑段）与 `POST /generations/video-composites`（合成，本地拼接，不经外部服务）。受理即 `202`，此时还没开始干活；上游的拒绝与加工失败会变成记录里的 `failed`，由调用方查状态看到。一行是哪种记录由 `kind`（`video` / `image`）、`operation`（`generate` 调模型、`compose` 本地拼接）与有没有来源 `sourceJobId` 决定（[ADR-0001](../docs/adr/0001-video-domain-model.md)）：出片是没有来源的 video / generate，编辑段是有来源的 video / generate，合成是 video / compose，图片是 image / generate。

业务状态每跳一格，属主连着的每条 WebSocket 都收到一帧 `event.generation.changed`（见 §5 全局帧）；帧易失且不带结果，`GET /generations` 与任务查询接口仍是事实源，浏览器在有运行中任务时保留轮询兜底。

带 `conversationId` 的提交还有一个副作用：那段对话若属于提交者且标过收尾，`completedAt` 被抹回 `null`（§6）。不属于提交者或对话不在了都当没发生，不影响受理。

### 归属标签 `user_name`

- 四种提交都带 `user_name`（图片与合成端点按 camelCase 叫 `userName`），含义与取值规则同发消息（§5）。

### 视频：镜像上游异步接口

- `POST /generations/video` 的请求体照上游视频异步接口（`model`、`prompt`、`user_name`、`reference_image_urls`、`reference_video_urls`、`reference_audio_urls`、`generate_audio`、`resolution`、`aspect_ratio`、`seconds`、`provider_options`），外加归属字段 `conversation_id`、`task_id`（需求单 id）、镜头组编号 `shot_index`（见下文「镜头组编号」）、调用方自带的标签 `metadata`（见下文「参考帧图片编辑」）与结构化的 `shot`。响应是 `{"task_id"}`，值是本系统这条生成记录的 id；请求体里的 `task_id` 是需求单 id，两者是两个层级。
- 正文二选一：直接给 `prompt`，或给 `shot`（与分镜文件 `video_shot.json` 里 `shots[].prompt` 同形：`global_settings` 加 `timeline[]`，每镜 `timestamps: [起, 止]`、`prompt`、`image_indexes`）由服务端拼成 `prompt`。时间线规则与分镜交付相同：结束晚于开始、第一镜从 0 起、各镜按先后排不重叠。拼法：全局设定、空一行、每镜一行 `[起–止秒｜镜头N] 正文`（起止照给的，保留到毫秒），末尾一行 `不要生成字幕，不要生成背景音乐。`。两者都不给、都给但不一致、`@ImageN` 超出 `reference_image_urls` 的张数、`image_indexes` 与正文里 `@Image` 的出现顺序不一致、拼出的正文超过 4000 字，都是 `422`。记录的 `request` 里 `shot` 与拼好的 `prompt` 都在；发给上游的只有 `prompt`，`shot` 不转发。
- 三类参考素材地址各自最多 30 个，与分镜文件里一组镜头的帧图上限同一个数；只收具有主机名的 HTTP(S) 地址，超出或地址不合规是 `422`。
- `model` 必填，只接受运行配置 `config.yaml` 中 `media_generation.video.allowed_models` 声明的模型；其余字段原样转发，画幅、时长范围、分辨率、素材规格由上游按模型判，本系统不复制那套规则。不在允许范围内的模型返回 `422`，不创建任务、不入队。
- `GET /generations/video-models` 给出默认模型与允许表，只有模型 id。哪个模型能做视频编辑、编辑时要给上游加什么（正文前缀或 `provider_options`）、哪些画幅某个模型不收，都由调用方按模型名自己认；服务端不替任何模型拼任何东西，也不声明画幅。
- 上游会丢弃的 `session_id` 与废弃别名 `image_urls` 在这里是未知字段，返回 `422`。
- `GET /generations/video/{task_id}` 照上游任务查询的形状：`task_id`、`type: "video"`、`status`、`result`、`error`、`created_at`。`status` 用上游的词：`queued`（已受理未提交）、`running`（提交中或等结果）、`succeeded`（带 `result.output_url` 与 `result.watermark_output_url`）、`failed`（带 `error.code` 与 `error.message`）。可见性与 `GET /generations/{id}` 相同，只答出片与编辑段；拿图片或合成的 id 来查是 `404`（合成不经上游、没有水印版，套不进这个形状）。本系统去上游查状态时带的 `user_name` 查询参数（上游缺它报 400）由服务端从记录里取，调用方不用带。

### 视频编辑：编辑段与合成

- `POST /generations/video-edits` 在一条成片上改一段：`source_job_id` 是基底，`range_start_ms` / `range_end_ms` 是要改的区间（毫秒；起点不小于 0、终点晚于起点，否则 `422`）；`model`、`prompt`、`user_name`、`reference_image_urls`、`seconds`、`provider_options` 与出片同义，照样转发上游；另收归属字段 `conversation_id`、`task_id` 与坐标 `metadata`。不收 `reference_video_urls`、`shot` 与 `root_job_id`，给了是 `422`。模型规则同出片。响应是 `GenerationEnvelope`。
- 编辑段走视频上游。提交上游前，服务端按区间从基底上切一段参考片段交给模型：不重编码，放在已配过期规则的前缀下，按编辑段的 id 命名，不落行。起点落在之前最近的关键帧上，片段可能比区间长、多出来的在开头；记录上的 `rangeStartMs` / `rangeEndMs` 随之改记实际切点，也就是模型真正看到的那一段。终点超出基底时长按基底时长截；起点不在基底之内是 `EDIT_RANGE_OUT_OF_BOUNDS`（消息里带基底时长），取不到基底是 `MEDIA_SOURCE_UNREACHABLE`，切不出来是 `MEDIA_PROCESS_FAILED`，存不进桶是 `OUTPUT_STORE_FAILED`，这几种失败发生时上游还没被调用。落库的 `request.reference_video_urls` 为空，片段地址只进发给上游的那一次请求。
- `POST /generations/video-composites` 只收编辑段的任务号 `sourceJobId`、`userName`，以及归属字段 `conversationId`、`taskId` 与坐标 `metadata`。服务端按编辑段的基底与实际区间算出各段——基底从头到起点（起点为 0 时没有这段）、编辑段产物整条、基底从终点到结尾——拼成同一原作下的新一版成片，存进本系统的桶、长期保留。记录的 `request.segments` 就是这几段，取到结尾的段 `end` 为 `null`，执行时按素材时长补齐，补出来为空的段跳过。一律重编码：画幅与帧率对齐到原片（按素材整条时长认），模型还回来的片段缩放去适配它，有一段带音轨就出音轨、没音轨的段补静音。
- 合成取不到素材是 `MEDIA_SOURCE_UNREACHABLE`，ffmpeg 处理失败是 `MEDIA_PROCESS_FAILED`，存不进桶是 `OUTPUT_STORE_FAILED`。编辑段与合成的这些失败都是终态，不自动重试。
- 记录上另有两个本地加工才填的字段：`durationMs` 是合成产物量出来的实际时长，完成后才有，别的记录恒为空；`clipStage` 是本地加工在途时跑到哪一步（`fetching` / `processing` / `uploading`，编辑段切片只有后两步），只在提交中、还没交给上游时非空，有了结论或交给上游后为空。阶段变化不发实时帧，调用方最多晚一轮轮询才看到。

### 来源与原作

- 每条生成记录带来源 `sourceJobId` 与原作 `rootJobId`，术语见 [CONTEXT.md「生成任务」](../docs/CONTEXT.md#术语)。编辑段的来源是它的基底成片，合成的来源是它的编辑段；两者的原作都是最初那条出片（基底是出片就是它自己，是合成就随那次合成的原作），不管基于哪一版，链因此只有一层。编辑段另带区间 `rangeStartMs` / `rangeEndMs`。出片与图片这几项都为空。它们都由服务端按来源定，调用方不直接给。
- 受理时核对来源：必须是调用方可见的、这段对话自己的或它继承的记录（继承的只在调用方读得到这段对话时才算，§6）；不存在、不可见、别的对话、继承边界之外，都是同一句 `422`。可见、在范围内但不合格的另给一句 `422`：编辑段的基底必须是一条已完成的成片（出片或合成），合成的来源必须是一条已完成的编辑段。都不创建任务、不入队。
- 编辑段与合成不计审计口径（§12）。`GET /generations?rootJobId=` 一次列出一条出片的整条编辑链，`?sourceJobId=` 列出直接基于某一行的记录；同时给 `conversationId` 时范围同那段对话的列表，分叉副本里连同继承的一起（§6）。

### 镜头组编号

- 出片请求的 `shot_index` 是这条出片属于第几个镜头组：正整数，从 1 起，与分镜文件的 `shots[].index` 同一套编号；可省略，省略就是一条没有镜号的出片。它落记录自己的列，不进 `request`、不发上游，读回是 `GenerationOut.shotIndex`。
- 编辑段与合成不收 `shot_index`（给了是 `422`），受理时抄基底的，也就是原作那一镜的。图片没有镜号，`shotIndex` 恒为 `null`。
- 镜号只认这一列：`metadata` 里写的 `shot` 不是镜号，审计与资料库都不看它。`GET /generations?shotIndex=` 按镜号筛。

### 图片

- `POST /generations/image` 只接受运行配置接入的那几家模型，`GET /generations/image-models` 声明有哪几家、各家支持的画幅与分辨率档位、以及有没有渠道这个轴。`model` 省略或为 `null` 时使用该接口给出的 `default`；受理阶段将选定模型写入请求快照。
- 图片的画幅与分辨率枚举是各家的并集。所选模型不支持这次的画幅或分辨率、点了没接入的模型、或给没有渠道轴的模型传了 `channel`，都返回 `422`，不创建任务、不入队。
- 图片的 `channel` 只对声明了渠道轴的模型合法，省略时按该模型声明的默认渠道填；它与视频的模型策略互不相干。
- `outputUrl` 存本系统地址。

### 参考帧图片编辑

- 图片请求的 `prompt` 由调用方编译成最终文本，服务端原样存进请求快照，不解析也不改写。前端把引用写成 `@图片N` / `@标注N`，编号即图片在本次 `referenceImageUrls` 里的位置。
- `metadata` 是调用方自己的标签：JSON 对象，四种提交都收，服务端原样存、原样回读（`GenerationOut.metadata`）、不读也不解释其中任何键，序列化后不超过 2000 字符，超了 `422`。它不进 `request`，也不发上游。这个形状归前端定义（`web/src/features/storyboard/generation-metadata.ts`）：分镜页给图片写 `{shot, frame}` 用来找格子，视频的镜号只在 `shot_index`。
- `GET /generations` 的类型（`kind`）、操作（`operation`）、对话、需求单、镜号（`shotIndex`）、原作（`rootJobId`）、来源（`sourceJobId`）与 `metadata` 筛选在分页截断前执行，归属范围不因筛选扩大，唯一的例外是按对话列分叉副本时连同它继承的记录（§6）。`metadata` 在查询串里是一段 JSON 对象（如 `metadata={"frame":2}`），按 JSONB 包含匹配；不是 JSON 对象返回 `422`。使用上一页最后一项的 `id` 作为 `before` 继续读取；按创建时间与 ID 倒序，空列表表示读完。每条记录带 `operation`、`shotIndex`、`taskId`、`watermarkOutputUrl`（图片与合成恒为 `null`）与 `finishedAt`（到终态的时刻，数据库时钟，没到终态为 `null`；同一原作下的成片按它排版本）。
- 生成完成只产生候选图片。应用到参考帧须由用户确认，再经现有工作区文件版本校验保存；既有视频任务和视频结果不随候选生成或采用而改写。

## 12. 审计报表 (Audit)

治理者看产量、成功率、耗时与模型消耗的三个只读端点，口径的定义见 [CONTEXT.md「审计口径」](../docs/CONTEXT.md#术语)。

- **分叉出来的副本一律不计入**（口径见 [CONTEXT.md「审计口径」](../docs/CONTEXT.md#术语)），分叉见 §6。
- 三个端点共用筛选 `since` / `until`（左闭右开）、`userName`、`taskId`。时间窗作用在各指标自己的锚点上：成片与视频耗时看完成时刻，每镜次数、一次通过、出片镜与有效镜看该镜首次出片时刻，运行看发起时刻，交付周期看最后成片时刻，模型用量整段对话按最后记账时刻归期。`since` 不早于 `until` 是 `422`。
- 每一格指标都是同一个 `metrics` 形状：`deliveries`（成片件数 = `deliveredTasks` + `deliveredOrphanConversations`）、`completedVideos`、`producers`、`shots` / `attempts` / `oneTakeShots`（只出了一条且成了的镜）与派生的 `attemptsPerShot`、`oneTakeRate`、`deliveredShots`（出片镜）/ `effectiveShots`（有效镜）与派生的 `effectiveRate`、`runs`（agent 运行次数，归发起人）、`deliveredConversations`、三组秒数分布 `cycleSeconds` / `videoSeconds` / `upstreamSeconds`（各带 `avg`、`median`、`p90`，没有样本为 `null`）、`usage`（五个 token 计数、`totalTokens`、`cacheHitRate`）与 `tokensPerDelivery`。分母为零的比率是 `null`。
- `GET /audit/summary` 返回 `overall`（整个筛选范围一格）、`users[]`（每人一行，成片件数多的在前；只跑过没出片的人也占一行）、`tasks[]`（每张有动静的需求单一行，带 `title`；没挂需求单的对话不在这里）。给 `bucket`（`day` / `week` / `month`）时多返回 `series[]`，每期一行带 `periodStart`，按 `timezone`（IANA 名，缺省 `UTC`）切：给了 `since` 时从 `since` 所在期到 `until`（缺省此刻）所在期每期都有一行，没动静的期计数为 0、比率与分布为 `null`；没给 `since` 只列有数据的期。不给 `bucket` 时 `series` 为 `null`。时区名不认识是 `422`。另带 `attemptDistribution[]`：整个筛选范围的出片次数分档计数（`attempts` 次的镜有 `shots` 个），次数少的在前、不封顶、只给全体一档（`users[]` / `tasks[]` / `series[]` 的行上没有）；次数是这个镜名下的全部出片记录数。锚点同每镜次数。还带 `anomalyCounts[]`：整个筛选范围里每种异常各几条（`kind`、`count`），按 `GET /audit/anomalies` 的缺省阈值判定，只列出现过的种类，多的在前、同数按种类名。
- `GET /audit/conversations` 列有成片的对话，最后成片晚的排前面；时间窗作用在最后成片时刻上，每行的 `metrics`、`shots[]`（镜号、次数、是否一次通过 `oneTake`、是否有效 `effective`、首末时刻）与 `usage[]`（按模型）都是这段对话的全量。`userName` 是这段对话归属的人，`startedAt` 是首次运行（没有运行就是对话创建）。属主删掉的对话照列，`deletedAt` 非空。翻页 `limit` 与 `cursor`，规则同 §6 审计列表。
- `GET /audit/anomalies` 列异常，按发生时刻倒序，翻页同上。`kind` 可重复给以只看某几种：`retry`（单镜生成次数超过 `retryOver`，缺省 2）、`idle`（有运行、无成片、最近活动距今超过 `idleHours`，缺省 24）、`slow`（交付周期超过筛选范围内的 P90）、`stuck`（视频停在 `submitted` 超过 `stuckHours`，缺省 1）、`spend`（对话总 token 超过筛选范围内的 P95）、`task_stuck`（需求单挂了至少 `taskConversations` 段对话、缺省 3，且没有成片）、`deleted`（属主删掉的对话，`value` 是它的成片数）、`no_task`（有成片却没挂需求单的对话）、`missing_shot`（出片却没有镜号 `shotIndex`，调用方接入退化的信号；编辑段与合成的镜号抄自原作，不算）。每行带 `kind`、`at`、`value`、`threshold` 与按需带的 `conversationId` / `taskId` / `userName` / `shot` / `generationId`。P90 / P95 按当前筛选范围现算，样本少时会抖。

## 13. 资料库 (Library)

全站成功出片连同出片时脚本的三个只读端点，都要 `generation:read`。收录口径、卡与卡面的定义见 [CONTEXT.md「资料库」](../docs/CONTEXT.md#术语)。

- **看得到全站，拿不到别人的对话**：任何持 `generation:read` 的人都能看到全部卡与脚本；`conversationId` 只对来源对话的属主与治理者（`users:manage`）给出，其余人恒为 `null`。对话标题 `title` 照给，不挂对话的出片为 `null`。
- `GET /library/videos` 按卡面时刻（`face.createdAt`）倒序，翻页 `limit` 与 `cursor`，规则同 §6。筛选：`userName`（归属的人）、`since` / `until`（左闭右开，作用在卡面时刻上）、`orientation`（`portrait` / `landscape`，按请求里的 `aspectRatio` 判，认不出比例的两边都不算）、`q`（按字面包含匹配卡面那次出片的正文与对话标题，不区分大小写；首尾空白去掉后为空即不筛）。`total` 是当前筛选下的卡数，只在第一页（不带 `cursor`）给，翻页时为 `null`。
- 卡上 `id` 是卡面那次出片的 id，`face` 是卡面放的那条（`kind` 为 `take` 或 `master`；成片没有水印版，`watermarkOutputUrl` 为 `null`，`durationMs` 是量出来的时长），`take` 是卡面那次出片的参数、脚本与名下成片，`takeCount` 是这一镜成功出过几次。
- `take.prompt` 是发给模型的原文；`take.script` 是镜头组（`globalSettings` 加 `timeline[]`，每镜 `start`、`end`、`prompt`、`imageIndexes`），为 `null` 表示纯文本。`imageIndexes` 指向 `referenceImageUrls` 的第 N 张。画面尺寸不在数据里，占位比例按 `aspectRatio`。
- `GET /library/videos/{id}` 返回这一镜：`video`（卡本身）、`takes[]`（全部成功出片，早的在前，各带名下成片）、`siblings[]`（同一段对话的其他镜，镜号小的在前）。`id` 可以是这一镜里任何一次出片；不在资料库里的（没成、衍生记录、已删对话、不存在）一律 `404`。
- `GET /library/authors` 列名下有卡的人与卡数（`userName`、`count`），多的在前、同数按名字，不受筛选影响。
