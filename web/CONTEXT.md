# Producer 领域锚点

本文是 Producer 前端的领域锚点：上下文（前端的背景事实）、术语（前端赖以工作的领域术语）、不变量（每条代码路径都必须成立的规则）、禁止逻辑（被刻意设计掉的推理模式）。

命令、边界与门禁见 [AGENTS.md](AGENTS.md)；接口级契约细节见 [docs/state-management.md](docs/state-management.md) 与 [docs/backend_api.md](docs/backend_api.md)。

## 上下文

- **定位**：Producer 是 Productor 视频创作产品的前端 SPA，作为 UI 参考稿保存在 iclip-agent monorepo 的 `web/`；浏览器只经同源 `/api` 访问后端，登录态为 HttpOnly cookie。它不约束本仓后端合同，前端对接范围与时点由用户决策。
- **界面主体**：首页工作台（Video Task 下发 / 确认双视角面板）、项目画布 + 聊天（Agent 工作台，经 AG-UI 协议与 agent 对话）、Task 驱动的 Storyboard、Direct Canvas（不经 Agent 会话直接使用画布）。
- **事实源分工**：聊天消息流只负责渲染；画布产物、媒体与生成任务的事实源是后端 Session Workspace 与 session assets/generations 接口；项目布局的事实源是 canvas-layout 接口。

## 术语

**Session Workspace documents**：
`GET /api/sessions/{sessionId}/workspace/files` 返回 canonical 逻辑路径，`GET /api/sessions/{sessionId}/workspace/file?path=...` 返回 UTF-8 正文与 opaque `ETag`。它们是画布持久化产物的唯一事实源。
_不是_：AG-UI 消息推导物、tool result 正文、前端缓存。

**Session assets / generations**：
`GET /api/sessions/{sessionId}/assets|generations` 返回媒体账本与生成任务事实。输入媒体由 asset `source = upload | import` 判定；不需要 AG-UI state 索引。

**Workspace artifact identity**：
Workspace 产物的稳定领域 id 由后端 canonical path 确定：`workspace:${path}`。它不是 message id、tool call id 或数据库 fact row id。

**Workspace 重读通知**：
任何工具出了结果都触发一次 Workspace 全量 list/read——写工作区的不止 `write_file` 那几件，镜头素材工具也会顺手往里写，按工具名筛就会漏掉它们。工具结果只是这个通知，不携带、不替代 Workspace 正文。

**项目（project）与会话（session）**：
project 是后端生成 id 的项目文件夹入口：Producer Agent 与 Direct Canvas 使用 `/projects/{projectId}`，Task 驱动的 Storyboard 使用 `/storyboards/{projectId}`。session 是 Agno 会话，也是运行目标与聊天运行态的归属单位；`target` 建 session 时选定、之后不可改，同一 Agent project 可以包含不同 target 的 sessions。AG-UI `threadId` 恒等于当前 `sessionId`，不是项目文件夹 id。

**Video Task 双视角（下发 / 确认）**：
首页 Task 面板分需求方「下发 Task」与策划师「确认 Task」两种视角。下发 = 创建 draft 后立即 publish（状态机 `draft → published → confirmed → withdrawn`，published/confirmed 均可撤回、均可作创作来源）；策划师在确认视角按部门 / 需求人 / 品牌筛选并 `POST …/confirm`。下发表单的部门只读展示当前用户 PMS 部门数组中的全部有效名称（按返回顺序去重，以 `、` 连接），后端以同一可信资料覆盖请求并冻结到 `brief.department`；已有 Task 不随用户调岗动态改写。Brief 的需求描述是按段落换行的中文标题纯文本；下发时 Tiptap 预置场景、服装、道具、灯光、动作姿势、人物族裔、制作备注七项灰字提示，用户完全未填写或清空时把七条提示物化为默认正文，用户只要填写过内容就原样提交、不自动补齐其它行。确认时复用同一编辑器修改整段需求并可追加口播旁白。确认人还可调整比例、时长与参考素材；比例使用 `9:16`、`16:9`、`3:4`、`1:1` 等规范选项，时长默认取首个参考视频的媒体时长并四舍五入为秒且允许覆盖。参考视频 Asset id 在 Task 创建或更新响应中可能被后端替换为 H.264 MP4 派生 Asset id，前端以后端返回的 Task 为事实。`styleNos` 为多选 Style 全集，主 Style（首位）生成产品快照。
_不是_：前端权限硬隔离（两视角当前同账号可切换）、后端选项字典（视频类型 / 平台 / 尺寸选项存展示值，可会话内自定义新增）。

**一次尝试（Storyboard Attempt）**：
一张需求单跑一次 Storyboard，就是一段对话。Storyboard 页面按需求单进（`/storyboards/{taskId}`），用 `GET /api/conversations/by-task/{taskId}` 列出自己在这张单下的历次尝试（后端按开始时间正序，左侧书签编号即第几次），每次尝试用自己的对话 id 作 AG-UI `threadId`。开始一次尝试就是 `POST /api/conversations`（`agentId` + `taskId`），不建项目、不建 session；项目只是个可选的口袋，随时 `PUT /api/conversations/{id}/project` 放进去。
_不是_：Project 与 Task 之间的关系表、按顺序或时间推断的映射、「Storyboard 项目」这种类型。

**联网检索事实（Web Search Fact）**：
用户在爆款视频搜索前确认的品类、使用场景与可选卖点；界面可以用受控中英词对预置并允许修改，但请求只提交英文检索词。它是本次搜索的瞬态表单状态，不写入 Brief、Task 或浏览器持久存储。
_不是_：任意机器翻译、从需求描述猜测的标签、平台限定词或搜索结果缓存。

**项目画布布局事实（Project Canvas Layout Fact）**：
`GET /api/projects/{projectId}/canvas-layout` 返回的 schema v1 节点位置快照，以 `revision` 做乐观并发控制，PUT 使用 `expectedRevision` 完整替换。它属于 project；Producer 本阶段只在 Direct Canvas 中消费该远端契约，Agent workspace 未接入项目布局 coordinator。
_不是_：React Flow 节点内容、Zustand 内存状态、localStorage 快照、viewport 或选中状态。

**聊天 Timeline（`ProjectChatTimelineItem[]`）**：
聊天侧栏唯一对话投影：user message、assistant 气泡、tool-log 段、ask、subagent flow 是同一层连续 siblings。身份键只来自后端 `message.id`、`toolCallId` 与 part index。
_不是_：轮次（turn）模型、消息合并账本。

**Response Shell**：
active run 期间唯一的等待态 assistant 气泡，随最新可见节点移动；无真实模型内容时 `parts` 为空，「正在回答」只由渲染层表达。
_不是_：真实 assistant message、可提取 artifact 的内容。

**HITL Interrupt**：
待处理的人机确认，来源只有 restore message 的 `metadata.custom.agui.interrupts` 或 live `RUN_FINISHED.outcome.interrupts[]`；用 `toolCallId` / `targetId` 定位，经 AG-UI `resume[]` 提交回同一 run 端点续跑。
_不是_：独立 HITL 接口、`state._required` 派生物、按轮次定位的对象。

**AG-UI Target**：
`VITE_AGUI_TARGET_PATH` 决定的后端挂载点（默认 `/agui/teams/producer`，interface 独立 `/agui` 命名空间），run 端点即 target path 本身，另派生 state / restore / status 子端点；run 历史使用 AgentOS 官方 `/api/sessions/{sessionId}/runs`。
_不是_：散落手写的端点路径。

**Direct 与 Agent scope**：
视频生成的两种提交范围：`{ type: "project", projectId }`（Direct 画布，任务只进 route-local 列表）与 `{ type: "session", sessionId }`（Agent Workspace artifact 内提交，任务经 session assets/generations 进画布并驱动轮询）。

**布局模式（`layoutMode: "auto" | "manual"`）**：
画布节点唯一布局模式。`auto` 由行序碰撞布局器安置；只有用户拖拽停止后提交成功才变 `manual`，并与坐标一起进入项目布局快照，此后坐标最高优先。
_不是_：按内容高度或视窗变化可随意改写的状态。

## 不变量

每条代码路径都必须成立；能机械守卫的已由门禁强制（见 AGENTS.md §7）。破坏任何一条是设计变更，不是重构。

1. **登录态只存在于后端种的 HttpOnly `iclip_session` cookie**；`GET /api/users/me` 是登录态唯一事实源（经 react-query-auth 进 TanStack Query 缓存）。前端 JavaScript 不持有、不存储、不转发任何 token（[ADR-0001](docs/adr/0001-vite-spa-same-origin-no-bff.md)）。
2. **浏览器只调用同源 `/api/*`**；vite proxy / 生产反代负责 `^/api` rewrite，cookie 自动携带，前端不注入 `Authorization` 头。Vite 不得把 `/api` 重定向到另一个 origin；host-only cookie 不跨 `localhost` / `127.0.0.1` 共享，同一登录会话必须固定 Host。`FRONTEND_PUBLIC_ORIGIN` 只定义 SSO 回跳的前端公开 origin。
3. **身份只来自后端**：聊天、HITL 与 tool log 使用 `message.id` / `toolCallId`（加 part index）；Workspace artifact 使用 canonical path 派生的 `workspace:${path}`；不存在前端派生轮次 id。
4. **画布持久化产物只从 Session Workspace list/read 恢复**；messages 只负责聊天渲染，工具结果只触发重新读取。
5. **`threadId === sessionId`**；session 运行态（messages、interrupts、eventIndex、stream lifecycle）只属于对应 `ProjectChatProvider(sessionId)`，project 层只管理列表、active、indicators 与订阅集合。`RUN_STARTED.runId` 只标识当前 AG-UI 生命周期；普通 run 的断流恢复只使用服务端提供的 `rawEvent.run_id + agui.event_index` 瞬态游标，前端不得假定两种 run id 相等。HITL continuation 的 `resume[]` 是一次性用户响应，断流后不得自动重发或与 `reconnect` 组合，只能在重新挂载后从 session restore 恢复。
6. **权限门控只判 `user.permissions` 后端权限字符串**（如 `analytics:read`）。
7. **边界过 zod、非法即失败**：环境变量经 `env.ts` schema，REST 响应经 `apiFetch(path, schema)`；Workspace read/PUT 必须返回 `ETag`，缺失即失败。AG-UI state 是通用官方 state，前端不要求产品私有字段。
8. **服务器是项目布局唯一事实源**：React Flow 只产生交互事件，Zustand 只持有当前页面的可交互布局，TanStack Query 负责服务器快照与 revision。不得使用 localStorage 建立平行布局事实源。
9. **布局只按稳定 `nodeId` 对齐业务节点**；不得使用数组下标、节点总数或可变排序生成会随业务数据增量变化的 ID。
10. **`manual` 节点坐标最高优先**：artifact/media 同步、高度测量、fit view / zoom 都不得改写。
11. **不伪造数据**：后端缺 `createdAt` / `updatedAt` 保留 `null`；孤立 tool result 丢弃而不合成 fake message；`video_shot.json` 无法结构化时显式投影失败，不 fallback。
12. **Storyboard 只消费后端发放的对话 id**：页面按 URL 上的 `taskId` 读需求单、按 `by-task` 列出的对话切换与恢复各次尝试（当前看哪一次写在 URL 的 `attempt` 上），不维护 runtime registry 或运行记录副本。

## 禁止逻辑

被刻意设计掉的推理模式，不得以「临时方案」名义重新引入：

- **把消息流当事实源**：从 AG-UI messages、assistant parts、tool result 正文或聊天 timeline 提取画布 artifact、媒体或项目标题。事实源永远是 Session Workspace、session assets/generations 与项目接口。
- **轮次思维**：生成、传输或依赖 `turn-N` / `turnId`；用最新消息、本地 running 状态或 analysis 顺序推导轮次；为恢复当前轮插入本地消息。
- **认证转换层思维**：BFF、cookie 换发、`producer_access_token`、localStorage 会话、前端注入 `Authorization`。同源部署下这层转换没有存在价值（ADR-0001）。
- **前端兜底或重复校验后端投影**：为孤立 tool result 合成 assistant message、为缺失 interrupts 伪造 pending 状态、交叉校验后端已组装的 placeholder / ask anchor，或把无法解析的 workspace 文件降级为 Markdown。后端 restore 形状由后端 contract tests 守护；前端只消费 canonical messages。
- **用刷新重置运行态**：active run 期间或 RUN_FINISHED 后，从任何刷新接口 reset live runtime messages。刷新只同步业务 state / artifact / media。
- **布局本地兜底**：布局 GET/PUT 失败时改读写 localStorage、伪造已保存结果，或在 React Flow、Zustand 和 TanStack Query 之间复制多份节点坐标事实。
- **静默覆盖布局冲突**：忽略 `expectedRevision`、把 409 当作成功、用 last-write-wins 或隐式节点合并覆盖其他客户端已保存的快照。
- **身份白名单**：用前端用户名列表做权限门控。
- **组件里的主题分支**：`data-theme`、主题 Provider、组件自己判断明暗。浅深两套 token 同名换档，主题只由 `<html>` 上的 `.dark` 决定（`src/app/theme.ts` 是唯一开关），组件照常引用 token 即可。
- **sanitize 模型内容**：给 `RichMarkdownRenderer` 加 DOMPurify / allowlist / 兜底分支。模型 HTML 是可信内容，隔离靠 Shadow DOM。
- **平行运行时**：在 assistant-ui runtime 之外维护完整 message runtime、手写 subscriber、project 级 AG-UI multiplex / demux。
- **推断 Storyboard 关系**：按 Project 的 `sessionIds` 顺序、target、Task 顺序或当前选中项猜测 Task 与 Session；缺失显式关系时必须报错。
