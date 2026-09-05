# 跨端合同约定 (API Conventions)

> HTTP 端点与数据形状以 [`openapi.json`](openapi.json) 为准，生成流程见 [开发约定](../AGENTS.md)。本文补充跨端消费语义、认证、动态错误与 WebSocket 约定；领域术语和不变量见 [CONTEXT.md](../docs/CONTEXT.md)。

## 1. 部署与路由路径

- **路径代理**：前端浏览器代码只调用同源的 `/api/*`。在开发环境 (dev) 由 Vite Proxy 代理，在生产环境 (prod) 由 Nginx/Ingress 反向代理，将 `^/api` rewrite 掉后直达后端根路径（前端调用 `/api/users/me`，实际到达后端为 `/users/me`）。
- **保持同源**：`/api` 由反向代理转发，不用 `3xx` 把浏览器重定向到另一个 Host。会话 Cookie 不设置 Domain；同一次登录与 API 访问使用同一主机名，不混用 `localhost`、`127.0.0.1` 和局域网地址。
- **WebSocket 代理**：支持 `/api/ws` 的 Upgrade，并保留浏览器 Origin。后端以 Origin 与 Host 核对同源，代理应保留外部 Host，或显式配置允许的 Origin；不能通过删除 Origin 绕过校验。

## 2. 双主体认证 (Dual Principals)

- **浏览器会话**：使用后端设置的 HttpOnly Cookie `iclip_session`，浏览器自动携带；前端 JavaScript 不读取、存储或转发这个会话凭证，也不代持 API Key。
- **SSO 回调票据**：落地页接收查询参数 `jwt`，仅交给同源 `GET /auth/sso/callback` 验证并建立上述会话，随后以 replace 导航离开票据 URL。票据不作为后续 API 的认证头，不存入浏览器持久存储。
- **登录态**：以 `GET /users/me` 为准；`401` 表示未登录或会话失效，前端不从 SSO 票据或本地标记推断已登录。
- **机器端调用方**：基于 Bearer Token 的无状态调用（请求头携带 `Authorization: Bearer iclip_sk_...`）。
  - 明文仅在成功创建的响应中返回一次；权限语义见 [CONTEXT.md](../docs/CONTEXT.md)。

## 3. 数据载荷与格式 (Payload Formatting)

- **命名**：业务 HTTP API 的请求体、查询参数和响应使用 camelCase。既有例外是 SSO `authorization_url`、注册接口的用户状态字段，以及 §5 的 Transcript 协议字段；消费者按生成合同取名，新业务端点不沿用这些例外。
- **时间**：时间戳使用 ISO 8601 UTC。
- **标识**：资源 ID、游标与协议 ID 按各自合同使用，不从 URL、显示名称或序号推导资源身份。客户端 `prompt_id` 是消息幂等键；会话和运行 ID 由服务端发放，轮 ID 则是 Transcript 内的顺序标识。

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

请求结构校验与认证框架的错误可能使用列表或对象形式的 `detail`；客户端不能假定所有错误都是上述字符串信封。生成任务的业务失败通过任务状态与 `errorCode` / `errorMessage` 表达，HTTP 受理成功不代表生成成功。

## 5. Agent 对话 (Transcript)

agent 对话使用 kimi code 的 Transcript 协议，HTTP 端点挂在对话下面。该组 HTTP 读写与 WebSocket 建连均需 `agent:run`；写入限属主，治理者可读取其他用户的对话。

### 字段名：这一面照协议原样，不套 §3

Transcript 沿用协议字段，不统一改名；HTTP 形状仍从 OpenAPI 生成：

- **信封 snake_case**：`agent_id`、`has_more_older`、`has_more`、`latest_seq`、`prompt_id`、
  `since_seq`、`before_turn`、`after_turn`、`page_size`。
- **里面装的实体与操作 camelCase**：`turnId`、`stepId`、`frameId`、`toolCallId`、`hasMoreOlder`。

### 发消息

`POST /conversations/{id}/prompts`，体是 `{prompt_id, content}`。

- `prompt_id` 由客户端铸（乐观气泡靠它认领服务端回来的那条）。同一段对话里重发同一个 id
  返回已有那条，不会多起一次运行；换一段对话用同一个 id 是 `409`。
- 答复是这条消息的记录：这段对话空着就 `status: "running"`，正忙就 `"queued"`。

### 读

- `GET /conversations/{id}/transcript` 默认取最新轮次；`before_turn` 向旧翻，`after_turn` 取指定轮之后的内容，两者不能同时给。`has_more` 始终表示当前页之前还有更旧轮次，不是向新翻页的结束标志。
- `GET /conversations/{id}/transcript/ops?since_seq=` 补断线期间漏掉的批次。
  `complete: false` 表示要的批次已经出了窗口，整页重拉。
- `GET /conversations/{id}/prompts` 当前排程：`{active, queued}`。
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

`WS /ws` 一条连接订阅多段对话，经过同源代理时使用 `/api/ws`。WebSocket 帧不在 OpenAPI 中：标准 Transcript 实体与操作消费 [vendor](../web/src/shared/transcript/vendor/README.md)，本项目的连接帧 schema 位于 [connection.ts](../web/src/shared/transcript/connection.ts)。后端实际发出的帧序列与 REST 一页存成金样 [transcript/](transcript/)，由后端场景测试生成、前端测试解析，两端形状对不上会在其中一边先红。协议字段哪些填、哪些留空，以及加字段的规则，见 [ADR-0013](../docs/adr/0013-transcript-protocol-freeze.md)。

- 握手：服务端先发 `server_hello`（客户端只取 `heartbeat_ms`），客户端**每段对话各发一帧**
  `subscribe_v2`，体里 `session_id` 是对话 id，`transcript` 是按 agent 给的档位，带
  `transcript_since` 就是补批。协议里的 `client_hello` 我们不收。
- 退订一段发 `unsubscribe_v2`（体里 `session_id`）；关连接就是全退。
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

两帧**都不看订阅**：发给这个人当时连着的每一条连接，一段都没订也收得到。

| 帧 | 体 | 什么时候发 |
|---|---|---|
| `session.meta.updated` | `{session_id, title}` | 标题变了（自动起名或用户改名） |
| `event.session.work_changed` | `session_id` 在信封上，payload `{busy, pending_interaction, last_turn_reason}` | 对话运行活动发生变化 |

- **按属主派发**，不是见者有份：连接归谁由它握手时的主体定。
- `event.session.work_changed` 的 `last_turn_reason` 只在 `busy: false` 的那几帧上有：帧一律
  `exclude_none`，没有结局时那一项整个不出现（列表行上是 `null`，见 §6）。
- **两帧都是易失通知**，客户端据此更新列表；断线期间的变化不补发，重连后须重拉列表，从 `ConversationOut.title` 与 `activity` 对齐当前事实。
- 一条跑完接着起下一条会先发 idle 再发 busy。

#### 文件订阅

照 kimi 的 `watch_fs_add` / `watch_fs_remove` / `event.fs.changed`：文件变动是**会话事件，按订阅投递**，与 transcript 订阅各管各的。

| 帧 | 方向 | 体 |
|---|---|---|
| `watch_fs_add` / `watch_fs_remove` | 客户端 → 服务端 | `{ id, payload: { session_id, paths, recursive? } }`；回执 `ack`，payload `{ watched_paths, current_count }`；订看不见的对话 `code` 为 `40401` |
| `event.fs.changed` | 服务端 → 客户端 | `session_id` 在信封上，payload `{ changes: [{ path, change, kind }], coalesced_window_ms }`；`change` 为 `created` / `modified` / `deleted`，`kind` 恒为 `file`，`coalesced_window_ms` 恒为 `0` |

- 订的是文件就要路径一样；订的是目录，`recursive` 为假只看直接子项，为真看整棵。
- 帧上不带版本与写入者：收到就重读那个文件，`version` 在文件上；是不是自己刚写的由客户端记自己写回拿到的版本号来判。
- 工具与面板写文件都会触发通知。通知易失，重连后重拉文件列表对齐。

## 6. 对话 (Conversations)

**权限**：会话列表、搜索、审计和工作区读取需要 `agent:read`；创建、修改、删除与工作区写入需要 `agent:run`。Transcript 的历史、消息队列与订阅另按 §5，需要 `agent:run`。

- `GET /conversations` 返回自己的侧栏拓扑：合集及各自第一页对话、未分组合的第一页对话。对话按最近活动倒序，空合集也保留。
- **两个数字是真总数**：`ungroupedCount` 与每个合集的 `conversationCount`，与这一页给了几条无关。
- `GET /conversations`、`GET /conversations/ungrouped`、`GET /conversations/by-collection/{id}` 都收 `state`，三值 `all`（默认）/ `running` / `done`。`running` 是有轮次正在跑（含等审批），`done` 是没在跑而且跑完过至少一轮；从没发过消息的对话两边都不在，只出现在 `all` 里。`ungroupedCount` 与每个合集的 `conversationCount` 按同一个筛选算。
- 往下滑加载更多：`GET /conversations/ungrouped?cursor=` 与 `GET /conversations/by-collection/{collectionId}?cursor=`，都返回 `{ items, nextCursor }`。`cursor` 原样回传上一页的 `nextCursor`（把它当不透明字符串），为 `null` 表示没有更多了；形状不对是 `422`。
- **`by-collection` 不区分「合集不存在」「合集是别人的」「合集是空的」**，三种都给一页空的；这是只列自己对话的工作台接口。
- `GET /conversations/search?q=` 按标题搜自己的对话，返回扁平列表，最近活动的排在前面；`GET /conversations/by-task/{taskId}` 按开始时间正序。
- `lastRunId` 只标识最近一次运行，不能作为续读地址；刷新与重连按对话 ID 和 Transcript 水位恢复（§5）。
- `activity` 的领域语义见 [CONTEXT.md](../docs/CONTEXT.md)，变化通过 §5 的全局帧通知。
- **标题服务端自动起，只成功写入一次**：配置标题模型时，轮次结束后尝试起名；
  用户自己改过名（`PATCH`，或者开对话时就给了 `title`）的一律不碰。起不出来就还叫默认名，下一
  轮跑完再试，不报错。改名与自动起名都会发一帧 `session.meta.updated`（见 §5 全局帧）。
- 会话页首屏的标题在 `GET /transcript` 响应的顶层 `title` 上——**不在 `meta` 里**（那是协议形状，
  加字段会被客户端静默丢掉）。之后的变化只走推送，不用轮询。
- 普通用户访问其他人的对话返回 `404`。按需求单列尝试只列自己的；治理者读权限见下文。
- `PUT /conversations/{id}/workspace/file` 整份覆盖一个文件，体是 `{ path, content, expectedVersion }`，答复形状同 `GET .../workspace/file`。
  - **只有属主能写**：看不见的对话仍是 `404`，治理者看得见但写入是 `403`。
  - `expectedVersion` 是读到那一份的版本号，对不上是 `409`（文件不存在时任何版本都对不上，同样 `409`——不替调用方新建）。写成功后版本加一。
  - `path` 必须是文件列表里那个写法（规范形式），`/video_shot.json` 这种是 `422`。
  - `video_shot.json` 复用镜头表形状校验，不合法返回 `422`。面板写入不校验地址来源，也不把地址登记成对话素材；用户要让 agent 使用新地址，须以附件提交。

### 两处归属

- 归属关系见 [CONTEXT.md](../docs/CONTEXT.md)。`taskId` 用 `PUT .../task` 改，`collectionId` 用 `PUT .../collection` 改，给 `null` 就是摘掉。
- 需求单下的尝试按对话 `createdAt` 排，事后补挂不改变这个次序。
- 两处都给不存在的 id 是 `422`。

### 治理者复盘

治理者使用 `users:manage` 扩大读取范围，操作本身所需的 `agent:read` / `agent:run` 仍须具备。其他人的改名、换归属、删除、发消息路径返回 `404`；工作区覆盖写入返回 `403`。

- `GET /conversations/audit` 列全平台的对话，按最近活动倒序。筛选 `ownerUserId`、`taskId`、`since`、`until`（后两个作用在 `updatedAt` 上），可任意组合；没有 `users:manage` 是 `403`。
- 翻页给 `limit` 与 `cursor`：`cursor` 原样回传响应里的 `nextCursor`，为 `null` 表示没有更多了。自己编一个形状不对的是 `422`。
- `GET /conversations/{id}/transcript`、`.../transcript/ops`、`.../prompts`、`.../workspace/files`、`.../workspace/file` 允许治理者跨属主读取；`GET /conversations` 与 `GET /conversations/search` 对治理者也只列自己的对话。

### 附件

- 附件通过 `content` 的图片或视频 part 提交，只收 HTTP(S) URL；其他地址返回 `422`。本地文件先直传得到公开地址（§11），不要求先登记素材库。
- 附件提交会登记对话素材；普通正文 URL、面板文件内容与素材库登记均不会代替这一步，精确匹配与类型规则见 [CONTEXT.md](../docs/CONTEXT.md)。
- 图片输入保留原图引用；仅支持缩放的地址附带缩放像素，其他图片及视频保留媒体引用，内容由相应工具读取。提交成功不保证外部 URL 在后续读取时可用。

## 7. 产品资料查询 (Products)

`GET /products/{styleNo}` 按 **PDM 款号**精确查一个款，只读、零副作用。权限 `assets:read`。

- 跨系统查询使用返回的 `styleWms`，不要把 `styleNo` 当作 WMS 编号。
- 款号不存在、或已被上游标记删除，一律 `404`。

## 8. 合集 (Collections)

**权限**：`GET /collections`、`GET /collections/{id}` 需要 `collections:read`；`POST /collections`、`PATCH /collections/{id}`、`DELETE /collections/{id}` 需要 `collections:write`。

- 普通用户访问其他人的合集返回 `404`；治理者可读、改名和删除其他人的合集，不能据此取得其中对话的写权限。
- `GET /collections` 默认只列自己的，最近改动的排在前面；`?scope=all` 是治理者的全量视图，需要 `users:manage`，否则 `403`。翻页用 `limit` 与 `offset`。
- **属主取自登录身份**，请求体里带 `ownerUserId` 一类字段一律 `422`。

## 9. 创作需求单 (Tasks)

**权限**：`GET /tasks`、`GET /tasks/{id}` 需要 `tasks:read`；`POST /tasks`、`PUT /tasks/{id}`、`POST /tasks/{id}/publish`、`POST /tasks/{id}/confirm`、`POST /tasks/{id}/withdraw`、`DELETE /tasks/{id}` 需要 `tasks:write`。

- **可见性**：需求单没有属主，谁有 `tasks:read` 谁就看得见全部；看得见但不让改返回 `403`，`404` 只意味着这张单子不存在。
- `GET /tasks` 最近改动的排在前面。
- `PUT /tasks/{id}` 是**整体覆盖**，不是局部合并。
- **创建者取自登录身份**，请求体里带 `creatorUserId` 一类字段一律 `422`。

### 款号

- `styleNo` 只在创建请求体里，是主款号；`brief.styleNos` 是要拍的款全集，**主款排首位**。不给全集，服务端补成 `[styleNo]`；给了但首位不是主款 → `422`。
- `PUT` 改草稿不给 `styleNos` 会补成仅含原主款号的列表，首位给错 `422`；已下发的不给 `styleNos` 等于动了冻结字段，返 `409`。
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

- `styleWmsList` 使用产品资料响应中的 `styleWms`，编号与分类含义见 [CONTEXT.md](../docs/CONTEXT.md)。
- **排序与截断都在服务端做**：换一个 `sortBy` 是换一批样本，不是把同一批本地重排。

## 11. 素材上传 (Assets)

上传分两步：`POST /uploads/sign` 领一个 `assetId` 和一条限时直传地址，浏览器直接把字节 PUT 到对象存储，再 `POST /assets/{assetId}` 登记。外部地址上的东西（产品图、爆款库的视频）走 `POST /assets/import` **转存**进本仓对象存储再登记。

**权限**：`POST /uploads/sign`、`POST /assets/{assetId}`、`POST /assets/import` 需要 `assets:write`；`GET /assets`、`GET /assets/{assetId}` 需要 `assets:read`。

- `creatorUserId` 是查询维度；素材的共享范围见 [CONTEXT.md](../docs/CONTEXT.md)。
- `GET /assets` 最近登记的在前。
- **`upload.headers` 必须原样带上。** `Content-Type` 被签进了签名里，换一个值去 PUT 会被对象存储拒掉（`403`）。
- **`expiresAt` 之前必须发起上传**。过期后重新调用 `sign`，会拿到新的 `assetId`。
- **登记之前那个 `assetId` 还不是一份素材**，`GET /assets/{id}` 会 `404`。
- **登记可以重复调**：第二次返回同一行（还是 `201`）。
- 类型、大小和图片尺寸边界以 [素材规则](../server/src/iclip/domains/assets/models.py) 为准。直传图片在 `sign` 时校验客户端声明的宽高；登记时按桶中对象校验类型和大小。登记失败不代表已上传字节已删除。
- 桶内没有对应对象时登记返回 `409`；签名成功本身不代表上传完成。
- **`url` 是由对象 key 拼出来的，不是存的。不要把 `url` 当作素材的身份**，`id` 才是。
- 转存的 **`assetId` 由源地址算出来**：同一个地址转存多少次都是同一行，第二次连请求都不往上游发；上游原地换了图不会跟着更新。
- 转存按下载响应的 Content-Type 选择允许的媒体类型，大小按实际下载字节计算，图片解码后校验尺寸。取不回来、类型不收或图片校验不通过返回 `422`。
- 转存**不跟随重定向**：`3xx` 直接当取不回来。
- 素材库登记不会登记对话素材；把素材地址作为附件提交后，agent 才能按对话素材规则引用（§6）。
