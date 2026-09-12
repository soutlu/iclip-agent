# ADR-0009: 产物面板与分镜工作台

- 状态：已接受（2026-09-02；2026-09-03 两次修订：去掉文件历史表与用户侧文件、生成记录归生成任务表；产物双来源、文件变更帧、写入只校验形状、地址规则统一为对话素材；2026-09-11 修订：拆解与交付工具归入 `video` 能力包，见取舍）
- 推翻 2026-08-25 的「对话工作区对前端只读」：面板现在可以写工作区文件，写入走本文决策 2 的接口。
- 取舍「不做通用文件浏览器」已被 **[ADR-0015](0015-workspace-files-panel.md)** 推翻：整个工作区成为第三种产物来源，宿主的切换器换成并排标签。
- **[ADR-0007](0007-tool-declaration-surface.md)** 决策 2、5、6：范围规则挂 `args_validator`；帧上的 `view` 由服务端给；给人看的结果走 `ToolReturn.metadata`。本文的产物列表以工具帧为第二来源，`write_video_shots` 的地址规则改挂验证器。
- **[ADR-0005](0005-transcript-protocol.md)**：transcript 协议照抄 kimi；本文的文件变更通知用它现成的 `watch_fs_add` / `event.fs.changed`，不自造帧。
- **[ADR-0008](0008-activity-from-agent-jobs.md)**：帧在写入那一刻发、易失；本文的文件变更帧同此，但按订阅投递而非全局。
- **[ADR-0004](0004-generation-queue-in-postgres.md)**：生成任务是一行持久事实；本文给它加归属列，不改排队与判失败规则。
- **[ADR-0001](0001-architecture-foundations.md)** §1：领域不依赖能力包；能力包可消费领域公开接口，跨模块适配由组合根连接。本文的校验复用按端口注入。

## 背景

`storyboard-workflow` skill 的终点是工作区里的 `video_shot.json`：逐镜头组的 prompt、秒数、帧地址列表，帧在 prompt 里以 `@ImageN` 标注。用户拿到它之后要做的事——改描述、换帧、上传自己的图当帧、出片、翻看各版视频、按组叫 agent 改——现在只能在聊天里用文字描述，看不到帧、看不到视频、看不到哪组改过。agent 交付之后任务就结束了，用户后续的操作不经过 agent。

右面板（`web/src/routes/-app-right-panel.tsx`）是壳里一块 460 宽的空占位，没有内容槽，会话页碰不到它。工作区文件对前端只有读接口，文件变了没有信号。生成任务表只记属主与 key，不知道一次生成属于哪段对话的哪一组。视频生成结果是 provider 地址，会过期。

参考 WorkBuddy 的产物列表与按类型分派渲染器的做法，不移植其协议或文件系统实现。

## 决策

### 1. 前端：一个产物面板宿主，一张产物类型注册表

- **产物**来自工作区文件和工具帧，在客户端经过注册表合成列表；工具帧的候选与匹配规则由 [ADR-0014](0014-subagent-panel.md) 补充，[ADR-0015](0015-workspace-files-panel.md) 补充整个工作区这一来源。产物、登记条目和渲染器 props 以 [artifact.ts](../../web/src/shared/workbench/artifact.ts) 为准。
- **宿主**（`shared/`）负责布局、产物合成与选中、渲染器分派及空态，不认识具体业务类型；切换器与文件浏览的后继决策见 [ADR-0015](0015-workspace-files-panel.md)。
- **登记**在 `app/` 层：把 `features/storyboard` 的渲染器登进注册表。宿主与渲染器互不 import。
- 分镜文件按完整路径匹配同一个工作台；新增产物类型通过注册表登记渲染器，不改宿主的分派逻辑。
- 壳的右面板改为槽位：会话路由用 TanStack Router 的 `staticData` 声明自己的面板组件，壳按当前匹配渲染。
- 布局 token 以[设计系统](../../design-system.html)为准，先改规范再同步运行时。
- 文件来源由工作区变更事件刷新，帧来源随工具帧更新；重连后重拉对齐，不轮询。订阅范围由 [ADR-0015 决策 4](0015-workspace-files-panel.md#4-刷新信号宿主订整个工作区)补充。

### 2. 后端：工作区只放 agent 的产物，文件可写，写入只校验形状

- 工作区里只有 agent 工具写下的文件。用户在面板里改 `video_shot.json` 是改 agent 的产物；用户自己产生的状态（出片记录、以后的配音）不进工作区。
- 只有对话属主能写，治理者仍只读；写入沿用 file_store 的乐观版本校验，版本冲突返回 409。端点、权限与请求字段见[跨端合同](../../contract/conventions.md#6-对话-conversations)。
- 组合根向 conversations 域注入按路径匹配的校验器。`video_shot.json` 的写回**只校验形状和引用一致性，不校验地址来源**；与工具交付共用 [shot_document.py](../../server/src/iclip/capabilities/shot_document.py)，由组合根包装接入。校验失败返回 422，错误原文给前端。
- **文件变更通知照 kimi**，帧与订阅语义见[跨端合同](../../contract/conventions.md#5-agent-对话-transcript)。发帧统一放在组合根包装的工作区存储层，工具、子代理和 REST 写入都经过它；不维护「哪些工具会产文件」的清单，也不增加文件系统 watcher。
- 工作区文件没有历史，不做回退。

### 3. agent 侧的地址规则统一为对话素材

- `write_video_shots` 的 `image_urls` 通过 `args_validator` 校验对话素材与类型，不依赖 `frames/grids/*.json`。来源判定以 [ADR-0010](0010-materials-ledger.md) 的精确 URL 台账为准，与 `ReadMediaFile`、`generate_shot_frames` 共用素材约束。
- 这条规则约束 agent 引用素材，不替代面板的文件形状校验。读取文件不会登记素材；用户在面板新增的地址需通过附件提交进入台账，agent 才能引用。

### 4. 生成任务归属到对话

- `generation_jobs` 加两列，都可空、不建外键：`conversation_id`、`shot_index`；索引 `(conversation_id, created_at)`。`GET /generations` 加 `conversationId` 过滤。2026-09-09 修订：再加需求单归属 `task_id` 与对应索引、过滤，见 [ADR-0018](0018-video-generation-mirrors-upstream.md)。2026-09-12 修订：`shot_index` 列并入调用方自带的 `metadata`，见 [ADR-0020](0020-generation-metadata.md)。
- 面板发起的生成三列都填；工具发起的生成填 `conversation_id`（`deps` 里有），`shot_index` 留空。
- 同一组多次生成就是多条任务行，不持久化「当前用哪条」。面板默认显示该组最新一条完成的视频。
- 视频结果原先与图片一样转存进本系统的桶，2026-09-09 起改为直接存上游发布好的地址，见 [ADR-0018](0018-video-generation-mirrors-upstream.md)。
- 面板发起的生成不设幂等键（[ADR-0004](0004-generation-queue-in-postgres.md) 与不变量 10 未变）。2026-09-07 修订：单组生成仅在提交请求未返回时禁用按钮、防止重复点击；任务受理后可继续调整模型并生成新版本。此前整个生成期间禁用按钮的规则不再适用，后台任务状态由「生成记录」入口显示当前组的进行中视频任务数。批量生成仍跳过已有运行任务的组。

### 5. 用户上传的帧走素材路径

面板「上传一张当帧」复用聊天附件那三步：`POST /uploads/sign` 直传许可 → 浏览器 PUT 进桶 → `POST /assets/{asset_id}` 登记。它是一份素材，不是产物，不进工作区，不给素材表加对话归属。登记返回的地址由前端插进该组 `image_urls`，重排编号后整份 PUT。2026-09-12 修订：登记改为无状态的 `POST /uploads/{uploadId}/confirm`，素材表下线，见 [ADR-0022](0022-uploads-without-registry.md)。

### 6. 分镜工作台的产品行为

- 以镜头组组织预览、编辑与生成；全局设定、时间线镜头和未引用图片分别选择，内容身份独立于它引用的图片，不能用选中帧反推当前镜头。
- 底部胶片条：每组时长、序号、组名、一个状态圆点。末尾「新增」只发给 agent。
- 「全部分镜」上拉浮层：网格、多选、批量下载 / 复制 prompt / 删除（发给 agent）、把选中的组发给 agent、批量生成。
- 「生成记录」浮层：该组的视频版本按时间倒序，标状态，点一条在大画面里播。
- 描述编辑器用仓里已有的 ProseMirror 加一个帧芯片节点。**往返保真**：解析再序列化必须逐字等于原文，唯一允许的变化是帧增删移位后的 `@ImageN` 重编号；段落结构解析不出就整段当纯文本。
- 帧操作包含替换、移除与移动；前端同步图片顺序与正文引用编号，整份写回。渲染只看地址，不问来源；上传遵循决策 5 的素材路径。
- 保存即时，带读到的版本。409 时重拉：冲突不在用户正在改的那一组就自动重放，否则交给用户选。不静默覆盖。
- 生成消费已保存版本；上传中、保存失败或冲突未解决时不提交生成。
- 选中即上下文：用户选中组或帧，Composer 里出现引用 pill，发送时序列化成一行前缀文字。不设计结构化消息类型。
- 面板的产物、镜头组、内容、引用帧与视频版本选择保存在会话路由查询串，由 routes 校验；字段以[会话路由 schema](../../web/src/routes/_shell/c.$conversationId.tsx)为准。
- 收到 `event.fs.changed` 重读文件后，版本号不是自己上一次写回拿到的那个，对应组标「agent 刚改过」。

## 取舍

- **不做无限画布。** 镜头组是有序序列，用户操作的是对象不是位置；画布若将来出现，是注册表里的一种类型。
- **不给工作区加历史表，不做回退。**
- **不为出片记录另开领域或文件。** 生成任务表加两列归属就够；配音等后续记录同样归属到对话，不进工作区。
- **不校验用户写入的地址来源，不给素材加对话归属。** 用户是属主，用哪张图是他的权利；agent 侧另有对话素材验证器约束模型。代价是原来「agent 不能把素材图当帧」的硬拦放宽为「对话里出现过即可」，由 skill 文本约束。
- **工具签名、返回值、错误消息、SKILL.md 与 references 不变；只改 `write_video_shots` docstring 一句。** `video_shot.json` 仍由 `write_video_shots` 整份交付。2026-09-10 修订：每组 `image_urls` 加 30 张上限，见[跨端合同](../../contract/conventions.md#6-对话-conversations)。2026-09-11 修订：`video_parser` 与 `write_video_shots` 归入 `video` 能力包，`shot_video` 只留取帧与出图；工具名与文件不变。
- **接受两个写者。** agent 与用户写同一份 `video_shot.json`，靠版本锁兜底，不加运行期互斥。
