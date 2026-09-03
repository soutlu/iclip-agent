# ADR-0009: 产物面板与分镜工作台

- 状态：已接受（2026-09-02；2026-09-03 两次修订：去掉文件历史表与用户侧文件、生成记录归生成任务表；产物双来源、文件变更帧、写入只校验形状、地址规则统一为对话素材）
- 推翻 2026-08-25 的「对话工作区对前端只读」：面板现在可以写工作区文件，写入走本文决策 2 的接口。
- **[ADR-0007](0007-tool-declaration-surface.md)** 决策 2、5、6：范围规则挂 `args_validator`；帧上的 `view` 由服务端给；给人看的结果走 `ToolReturn.metadata`。本文的产物列表以工具帧为第二来源，`write_video_shots` 的地址规则改挂验证器。
- **[ADR-0005](0005-transcript-protocol.md)**：transcript 协议照抄 kimi；本文的文件变更通知用它现成的 `watch_fs_add` / `event.fs.changed`，不自造帧。
- **[ADR-0008](0008-activity-from-agent-jobs.md)**：帧在写入那一刻发、易失；本文的文件变更帧同此，但按订阅投递而非全局。
- **[ADR-0004](0004-generation-queue-in-postgres.md)**：生成任务是一行持久事实；本文给它加归属列，不改排队与判失败规则。
- **[ADR-0001](0001-architecture-foundations.md)** §6：能力包之间、能力包与领域之间不互相 import；本文的校验复用按端口注入。

## 背景

`storyboard-workflow` skill 的终点是工作区里的 `video_shot.json`：逐镜头组的 prompt、秒数、帧地址列表，帧在 prompt 里以 `@ImageN` 标注。用户拿到它之后要做的事——改描述、换帧、上传自己的图当帧、出片、翻看各版视频、按组叫 agent 改——现在只能在聊天里用文字描述，看不到帧、看不到视频、看不到哪组改过。agent 交付之后任务就结束了，用户后续的操作不经过 agent。

右面板（`web/src/routes/-app-right-panel.tsx`）是壳里一块 460 宽的空占位，没有内容槽，会话页碰不到它。工作区文件对前端只有读接口，文件变了没有信号。生成任务表只记属主与 key，不知道一次生成属于哪段对话的哪一组。视频生成结果是 provider 地址，会过期。

WorkBuddy 桌面端（本机 5.3.14 的构建产物）的右侧 DetailPanel 作为参考实践，不移植：一张产物列表，选中一项，按 `type / customType` 分派到渲染器；图片、PDF、HTML 直播预览、设计画布都是列表里的一项，画布只是设计文件那一种类型的渲染器；产物由服务端从工具帧投影成精确的 created / updated 事件，客户端不轮询；用户在预览里选中一段内容，输入框里出现引用块随消息发出；HTML 编辑器保存回沙箱文件。

## 决策

### 1. 前端：一个产物面板宿主，一张产物类型注册表，产物有两个来源

- **产物**：`{ id, type, title, source }`，`source` 二选一：`{ kind: "file", path, version }`（工作区文件）或 `{ kind: "frame", toolCallId, view, metadata }`（工具帧上给人看的结果）。`id` 分别是 `file:<path>` 与 `frame:<toolCallId>`。列表由文件列表与 transcript 里已完成的工具帧各过一遍注册表合成，在客户端算。
- **注册表条目**：`{ type, match: { path } | { view }, title, component, autoOpen, actions?, fullscreen? }`。渲染器组件的 props 固定为 `{ conversationId, artifact, selection, composerBridge }`。
- **宿主**（`shared/`）只管几何（宽度、放大、折叠、中断点）、两个来源的合成与选中态、分派、空态，不认识任何具体类型。产物只有一个时不显示切换器。宿主与双来源合成第一期就做全并有单测，注册表第一期只登记一条。
- **登记**在 `app/` 层：把 `features/storyboard` 的渲染器登进注册表。宿主与渲染器互不 import。
- 第一期只登记 `storyboard`：`match: { path: "video_shot.json" }`，`autoOpen: true`。markdown 预览、媒体墙、补拍设定图、画布都只是再登记一条。
- 壳的右面板改为槽位：会话路由用 TanStack Router 的 `staticData` 声明自己的面板组件，壳按当前匹配渲染。
- 布局 token 先进 `design-system.html` 再进运行时：工作台默认 820、聊天最小 400、窄于 1280 时聊天收成抽屉。
- 刷新信号：面板打开时用 `watch_fs_add` 订它要看的路径，文件来源听 `event.fs.changed` 只重读那一个文件；帧来源就是工具帧到达 done。重连后整体重拉一次对齐。不轮询、不盲拉。

### 2. 后端：工作区只放 agent 的产物，文件可写，写入只校验形状

- 工作区里只有 agent 工具写下的文件。用户在面板里改 `video_shot.json` 是改 agent 的产物；用户自己产生的状态（出片记录、以后的配音）不进工作区。
- `PUT /conversations/{conversation_id}/workspace/file`，请求 `{ path, content, expectedVersion }`，权限 `agent:run`，只有对话属主能写，治理者仍只读。版本对不上回 409。底层用 file_store 现有的 `expected_version` 写。
- 组合根注入一张「路径 → 校验器」表给 conversations 域，接线方式同 `PurgeDerived`。`video_shot.json` 的校验器**只看形状**：JSON 结构、画幅、序号连续、秒数 4–30、`@ImageN` 不超过帧数。**不校验地址来源**：地址是用户的事，不看它来自哪个桶、哪段对话。形状函数与 `write_video_shots` 工具体共用一份，住在 shot_video 包里，bootstrap 包装接入。校验失败回 422，错误原文给前端。
- **文件变更通知照 kimi**：客户端用控制帧 `watch_fs_add` / `watch_fs_remove`（`{ session_id, paths, recursive? }`）订路径，服务端发会话事件 `event.fs.changed`（payload `{ changes: [{ path, change, kind }], coalesced_window_ms }`），只到订了的连接。帧上不带版本与写入者：收到就重读文件，是不是自己刚写的由客户端记自己写回拿到的版本号来判。发帧点是组合根包在工作区文件存储上的那一层：所有工作区写入（五件工具、下属 agent、REST）都经这一个入口，不维护「哪些工具会产文件」的表，也不需要 kimi 那个文件系统 watcher。
- 工作区文件没有历史，不做回退。

### 3. agent 侧的地址规则统一为对话素材

- `write_video_shots` 的 `image_urls` 不再要求在 `frames/grids/*.json` 记录里，改挂 `args_validator`：地址在这段对话里出现过即可，与 `ReadMediaFile`、`generate_shot_frames` 参考图同一套机制（CONTEXT.md「对话素材」，ADR-0007 决策 2）。工具体里扫帧记录的代码删除。
- 这条规则只约束 agent 自己运行时能引用什么，与用户交付后做什么无关。用户叫 agent 重改某组时 agent 按 skill 先读文件，读到的地址即成对话素材。
- 工具面文字只改 `write_video_shots` docstring 里那一句：「自己拼的、以及对话里那些素材图的地址都会被拒」改为「只收这段对话里出现过的地址」。SKILL.md 与 references 不动；签名、返回值、错误消息不变。

### 4. 生成任务归属到对话，视频结果转存

- `generation_jobs` 加两列，都可空、不建外键：`conversation_id`、`shot_index`；索引 `(conversation_id, created_at)`。`GET /generations` 加 `conversationId` 过滤。
- 面板发起的生成两列都填；工具发起的生成填 `conversation_id`（`deps` 里有），`shot_index` 留空。
- 同一组多次生成就是多条任务行，不持久化「当前用哪条」。面板默认显示该组最新一条完成的视频。
- 视频结果与图片一样转存进本系统的桶后才算完成，`output_url` 存本系统地址。
- 面板发起的生成不设幂等键（[ADR-0004](0004-generation-queue-in-postgres.md) 与不变量 10 未变），前端在飞行中禁用按钮。

### 5. 用户上传的帧走素材路径

面板「上传一张当帧」复用聊天附件那三步：`POST /uploads/sign` 直传许可 → 浏览器 PUT 进桶 → `POST /assets/{asset_id}` 登记。它是一份素材，不是产物，不进工作区，不给素材表加对话归属。登记返回的地址由前端插进该组 `image_urls`，重排编号后整份 PUT。

### 6. 分镜工作台的产品行为

- 一屏一个镜头组：左侧大画面放该组最新完成的视频，没有就放首帧；画面底部一行帧缩略图，顺序即 `@ImageN` 编号；右侧序号、组名、时长、帧数、「分镜描述」文本、唯一主按钮「生成视频」。左右箭头切组。
- 底部胶片条：每组时长、序号、组名、一个状态圆点。末尾「新增」只发给 agent。
- 「全部分镜」上拉浮层：网格、多选、批量下载 / 复制 prompt / 删除（发给 agent）、把选中的组发给 agent、批量生成。
- 「生成记录」浮层：该组的视频版本按时间倒序，标状态，点一条在大画面里播。
- 描述编辑器用仓里已有的 ProseMirror 加一个帧芯片节点。**往返保真**：解析再序列化必须逐字等于原文，唯一允许的变化是帧增删移位后的 `@ImageN` 重编号；段落结构解析不出就整段当纯文本。
- 帧操作：替换（候选来自本对话 `frames/grids/*.json` 记录，或上传）、移除、左右移动；前端重排 `image_urls` 与芯片编号，整份 PUT。渲染只看地址，不问来源。
- 保存即时，带读到的版本。409 时重拉：冲突不在用户正在改的那一组就自动重放，否则交给用户选。不静默覆盖。
- 选中即上下文：用户选中组或帧，Composer 里出现引用 pill，发送时序列化成一行前缀文字。不设计结构化消息类型。
- 面板状态 `artifact`、`shot`、`frame`、`take`、`sheet` 放会话路由的查询串，routes 层 zod 校验。
- 收到 `event.fs.changed` 重读文件后，版本号不是自己上一次写回拿到的那个，对应组标「agent 刚改过」。

## 取舍

- **不做通用文件浏览器。** 宿主与注册表是为第二种产物类型留的口子，第一期不登记第二条。
- **不做无限画布。** 镜头组是有序序列，用户操作的是对象不是位置；画布若将来出现，是注册表里的一种类型。
- **不给工作区加历史表，不做回退。**
- **不为出片记录另开领域或文件。** 生成任务表加两列归属就够；配音等后续记录同样归属到对话，不进工作区。
- **不校验用户写入的地址来源，不给素材加对话归属。** 用户是属主，用哪张图是他的权利；agent 侧另有对话素材验证器约束模型。代价是原来「agent 不能把素材图当帧」的硬拦放宽为「对话里出现过即可」，由 skill 文本约束。
- **工具签名、返回值、错误消息、SKILL.md 与 references 不变；只改 `write_video_shots` docstring 一句。** `video_shot.json` 仍由 `write_video_shots` 整份交付。
- **接受两个写者。** agent 与用户写同一份 `video_shot.json`，靠版本锁兜底，不加运行期互斥。
- **接受视频转存的存储成本。** 不转存则多版本随 provider 有效期失效。
