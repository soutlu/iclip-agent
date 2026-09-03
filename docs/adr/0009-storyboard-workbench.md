# ADR-0009: 产物面板与分镜工作台

- 状态：已接受（2026-09-02）
- 推翻 2026-08-25 的「对话工作区对前端只读」：面板现在可以写工作区文件，写入走本文决策 2 的接口。
- **[ADR-0007](0007-tool-declaration-surface.md)** 决策 5：帧上的 `view` 由服务端给、前端按它选渲染器；本文的产物列表第一期不依赖它，将来接进来时走同一张注册表。
- **[ADR-0004](0004-generation-queue-in-postgres.md)**：生成任务是一行持久事实；本文给它加来源列，不改排队与判失败规则。
- **[ADR-0001](0001-architecture-foundations.md)** §6：能力包之间、能力包与领域之间不互相 import；本文的校验复用按端口注入。

## 背景

`storyboard-workflow` skill 的终点是工作区里的 `video_shot.json`：逐镜头组的 prompt、秒数、帧地址列表，帧在 prompt 里以 `@ImageN` 标注。用户拿到它之后要做的事——改描述、换帧、出片、挑成片、按组叫 agent 改——现在只能在聊天里用文字描述，看不到帧、看不到视频、看不到哪组改过。

右面板（`web/src/routes/-app-right-panel.tsx`）是壳里一块 460 宽的空占位，没有内容槽，会话页碰不到它。工作区文件对前端只有读接口。生成任务表只记属主与 key，不知道一次生成属于哪段对话的哪一组。工作区文件表只有一个 `version` 数字，没有历史。视频生成结果是 provider 地址，会过期。

WorkBuddy 桌面端（本机 5.3.14 的构建产物）的右侧 DetailPanel 作为参考实践，不移植：一张产物列表，选中一项，按 `type / customType` 分派到渲染器；图片、PDF、HTML 直播预览、设计画布都是列表里的一项，画布只是设计文件那一种类型的渲染器；产物由服务端从工具帧投影出来；用户在预览里选中一段内容，输入框里出现引用块随消息发出；HTML 编辑器保存回沙箱文件，agent 下一轮读文件。

## 决策

### 1. 前端：一个产物面板宿主，一张产物类型注册表，第一期登记一种类型

- **产物**：`{ id, type, title, source: { path, version } }`。第一期唯一来源是工作区文件，列表由文件列表按注册表的路径规则在客户端推出，不改服务端。
- **注册表条目**：`{ type, match(path), title(file), component, autoOpen, actions?, fullscreen? }`。渲染器组件的 props 固定为 `{ conversationId, artifact, selection, composerBridge }`。
- **宿主**（`shared/`）只管几何（宽度、放大、折叠、中断点）、产物列表与选中态、分派、空态，不认识任何具体类型。产物只有一个时不显示切换器。
- **登记**在 `app/` 层：把 `features/storyboard` 的渲染器登进注册表。宿主与渲染器互不 import。
- 第一期只登记 `storyboard`：匹配 `video_shot.json`，`autoOpen: true`。markdown 预览、媒体墙、画布都只是再登记一条。
- 壳的右面板改为槽位：会话路由用 TanStack Router 的 `staticData` 声明自己的面板组件，壳按当前匹配渲染。
- 布局 token 先进 `design-system.html` 再进运行时：工作台默认 820、聊天最小 400、窄于 1280 时聊天收成抽屉。

### 2. 后端：工作区文件可写，校验按路径注入

- `PUT /conversations/{conversation_id}/workspace/file`，请求 `{ path, content, expectedVersion }`，权限 `agent:run`，只有对话属主能写，治理者仍只读。版本对不上回 409。底层用 file_store 现有的 `expected_version` 写。
- 组合根注入一张「路径 → 校验器」表给 conversations 域，接线方式同 `PurgeDerived`。`video_shot.json` 走 shot_video 里现成的镜头组校验（含帧地址必须是本对话生成过的）；`takes.json` 走自己的 schema。校验失败回 422，错误原文给前端。
- **`takes.json`** 是用户拥有的文件：每组当前用的成片条。面板写，agent 只读；`write_video_shots` 整份覆盖 `video_shot.json` 时不碰它。第一期不改 SKILL.md，agent 经 `list_files` 看得见即满足不变量 11。

### 3. 工作区文件有历史

`platform.file_store` 加一张历史表：每次写入把被覆盖的内容连同来源（工具名或 REST）落一行。列表接口多返回最后一次写入的来源。「查看上一版、回退、agent 刚改过」都从这张表算。新表进迁移比对名单。

### 4. 生成任务带来源，视频结果转存

- 生成任务表加三个可空列：对话 id、镜头组序号、来源文件版本；不加外键。`GET /generations` 加 `conversationId` 过滤。
- 视频结果与图片一样转存进本系统的桶后才算完成。
- 面板发起的生成不设幂等键（[ADR-0004](0004-generation-queue-in-postgres.md) 与不变量 10 未变），前端在飞行中禁用按钮。

### 5. 分镜工作台的产品行为

- 一屏一个镜头组：左侧大画面放当前用的成片条，没有就放首帧；画面底部一行帧缩略图，顺序即 `@ImageN` 编号；右侧序号、组名、时长、帧数、「分镜描述」文本、唯一主按钮「生成视频」。左右箭头切组。
- 底部胶片条：每组时长、序号、组名、一个状态圆点。末尾「新增」只发给 agent。
- 「全部分镜」上拉浮层：网格、多选、批量下载 / 复制 prompt / 删除、把选中的组发给 agent、批量生成。
- 「生成记录」浮层：这组每次生成一行，选一条设为当前用；agent 与用户的改动排在同一条时间线，可看上一版、回退。
- 描述编辑器用仓里已有的 ProseMirror 加一个帧芯片节点。**往返保真**：解析再序列化必须逐字等于原文，唯一允许的变化是帧增删移位后的 `@ImageN` 重编号；段落结构解析不出就整段当纯文本。
- 帧操作：替换只从本对话 `frames/grids/*.json` 记录里的地址选，不上传；移除、左右移动后前端重排 `image_urls` 与芯片编号，整份 PUT。
- 保存即时，带读到的版本。409 时重拉：冲突不在用户正在改的那一组就自动重放，否则交给用户选。不静默覆盖。
- 选中即上下文：用户选中组或帧，Composer 里出现引用 pill，发送时序列化成一行前缀文字。不设计结构化消息类型。
- 面板状态 `artifact`、`shot`、`frame`、`sheet` 放会话路由的查询串，routes 层 zod 校验。
- 刷新时机：任何工具帧到达 done 重拉文件列表；版本变了且不是自己写的，对应组标「agent 刚改过」。

## 取舍

- **不做通用文件浏览器。** 宿主与注册表是为第二种产物类型留的口子，第一期不登记第二条，也不做产物的服务端投影。
- **不做无限画布。** 镜头组是有序序列，用户操作的是对象不是位置；画布若将来出现，是注册表里的一种类型。
- **不允许上传图当帧。** 工具校验只收本对话生成过的帧地址，放开要同时改校验与 SKILL.md。
- **工具签名、返回值、错误消息、SKILL.md 全程不变。** `video_shot.json` 仍由 `write_video_shots` 整份交付；用户拥有的状态全放 `takes.json`。
- **接受两个写者。** agent 与用户写同一份 `video_shot.json`，靠版本锁与历史表兜底，不加运行期互斥。
- **接受视频转存的存储成本。** 不转存则成片条随 provider 有效期失效。
