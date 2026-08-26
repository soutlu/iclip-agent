# 前端状态与跨层契约

> 这里只保留跨层请求、运行态事实源和高风险状态同步规则。普通组件局部状态遵守 [实现规范](./frontend-implementation.md)。
> 端点与 payload 细节的接口级说明见 [backend_api.md](./backend_api.md)；后端连接形态（同源 `/api` 直连、无 BFF）的决策与硬约束见 [ADR-0001](./adr/0001-vite-spa-same-origin-no-bff.md)。
> 本文描述冻结前端当前实现；其中 AgentOS / Agno / Team member event 等条目属于待切换的旧系统合同，不代表本仓 `server/` 当前能力。

## 登录态（服务端状态）

### Scope / Trigger

修改登录页、SSO 落地页、`src/shared/auth/**` 或任何读取登录态的代码时读取本节。

### Contracts

- 会话只存在于后端 fastapi-users 种的 HttpOnly `iclip_session` cookie 里；前端 JavaScript 不持有、不存储、不转发任何 token，不使用 localStorage/sessionStorage 保存登录态。
- `GET /api/users/me` 是登录态唯一事实源，返回 `{ user: {...camelCase} }` 包装；经 react-query-auth 进 TanStack Query 缓存（`src/shared/auth/session.ts` 的 `useUser` / `useLogin` / `useLogout`）。
- 登录 `POST /api/auth/login` 提交 OAuth2 表单（`application/x-www-form-urlencoded` 的 `username` / `password`），成功返回 204 并种 cookie，响应体不含 token。
- 登出 `POST /api/auth/logout`；后端返回 401（会话本就失效）视为登出成功。登录态变更后让路由守卫重新评估。
- 路由守卫在 TanStack Router `beforeLoad` 中执行（`src/shared/auth/guards.ts`），是 async，必须 `await`。
- 普通接口返回 401 时不得直接把用户缓存写成 `null` 或直接导航登录页；全局处理必须绕过缓存强刷 `/api/users/me`，成功确认后再 invalidate 路由。只有 `/users/me` 返回未登录时，`_authed` 守卫才跳登录；复核网络失败时保留最后一次已确认身份并暴露错误。
- SSO：`GET /api/auth/sso/authorize` 获取 `authorization_url`；后端 SSO 关闭时不挂 `/auth/sso/*` 路由（404），调用方据此探测可用性。回跳落地页 `/auth/sso/landing` 用 `jwt_token` 调 `GET /api/auth/sso/callback?jwt=...` 换会话 cookie。
- 页面/功能门控一律判 `user.permissions` 里的后端权限字符串（如 `analytics:read`，见 `src/shared/auth/producer-auth.permissions.ts`）；不引入任何前端用户名白名单。

### Wrong vs Correct

```ts
window.localStorage.setItem("access_token", loginResponse.access_token);
```

```ts
const { data: user } = useUser();
if (!canViewProducerAnalytics(user)) return <Forbidden />;
```

## 后端连接与 AG-UI Target

### Scope / Trigger

修改 `src/shared/config/agui-target.ts`、`src/features/chat/api/**`、`src/features/projects/api/**`、`vite.config.ts` 代理或 `VITE_AGUI_TARGET_PATH` 解析逻辑时读取本节。

### Contracts

- 浏览器只调用同源 `/api/*`；vite proxy（prod 反代同语义）把 `^/api` rewrite 掉转发给后端。所有请求 `credentials: "same-origin"`，cookie 自动携带；前端不注入任何 `Authorization` 头。
- `src/shared/config/agui-target.ts` 是前端 agent 运行端点的唯一事实源。Storyboard 使用固定的 `STORYBOARD_AGENT`（`{ id: "storyboard", runUrl: "/api/agents/storyboard/chat" }`，对应本仓后端 `POST /agents/{agentId}/chat`）；Producer 聊天仍使用由 `VITE_AGUI_TARGET_PATH` 解析出的 `PRODUCER_AGUI_TARGET`（`{ id, path, apiPrefix }`，旧后端形状，尚未接到本仓后端）。各 feature 不得再分别维护 agent id 或 `/api` 前缀常量。
- `VITE_AGUI_TARGET_PATH` 由 `src/shared/config/env.ts` 的 zod schema 读取，默认 `/agui/teams/producer`，只接受 `/agui/teams/<team_id>` 或 `/agui/agents/<agent_id>`；允许省略开头斜杠和末尾斜杠，`src/shared/config/agui-target.ts` 负责规范化并在非法时抛错。
- AG-UI run 直接使用对应 descriptor 的 `apiPrefix`，restore 使用 `${descriptor.path}/restore` 交给 `apiFetch` 或 `${descriptor.apiPrefix}/restore` 作为完整同源端点；run 历史直接使用 AgentOS 官方 `GET /api/sessions/{sessionId}/runs`。
- 默认 target 是后端已注册的 `/agui/teams/producer`，不得恢复为旧命名空间或未注册 team。
- `POST /api/projects` 只创建 Project 文件夹：Producer Agent 与 Storyboard 提交 `{ kind: "agent", title }`，普通项目提交 `{ kind: "direct", title }`；任何 Project 创建请求与响应都不包含 target 或 Video Task id。
- `POST /api/projects/{projectId}/sessions` 必须提交 `{ target }`；session 响应也必须包含非空 target。target 建 session 时选定、之后不可改，同一 Project 可以包含不同 target 的 sessions。
- `POST /api/video-task-sessions` 提交 `{ projectId, videoTaskId, target: "storyboard" }`，创建一个新的 Session 与显式关系；`GET /api/video-task-sessions?projectId=...` 是 Storyboard 页面 Task-Session 映射的唯一事实源。
- 首页 Agent projects 卡片是 project 文件夹入口，只能链接到 `/projects/{projectId}`；卡片本身不选择或写入具体 session，Producer 项目路由只加载与 `VITE_AGUI_TARGET_PATH` 同 id（默认 `producer`）的 sessions，缺少时再创建一个。
- 首页 Storyboards 只展示 `GET /api/video-task-sessions` 返回非空关系的 Agent Projects；新建入口是 Tasks 面板的“进入 Storyboard”，先创建 Project，再创建第一条 VideoTaskSession。
- 项目页初始化 session tabs 必须以 `GET /api/projects/{projectId}/sessions` 返回的完整项目 session 列表为事实源，按当前工作台 target 过滤后再选择 active session。不得把 project 入口降级为首页项目列表里的首条 session，也不得把项目页初始化绑定到 `GET /api/projects/{projectId}` 里的 `sessionIds` 聚合字段。
- Storyboard 页面按显式 `videoTaskId` 读取 Task，按对话 id 管理选择、运行与输出；不得按 Project 的 `sessionIds` 顺序、target、Task 顺序或时间做推断式关联。一个 Project 可以有多个 Storyboard，每段对话常驻一个独立 AG-UI runtime host（`shared/agui` 通用装配 `AguiConversationRuntimeProvider`，ADR-0006），仅 active 对话渲染工作台；切换任务不 `cancelRun`、不中断其它对话的后台流。历史经 `GET /api/conversations/{id}/messages` 读回注水，没有「在途 run」决策，注水后不自动发起任何 run；不得复制 messages、isRunning 出 runtime（运行徽标只经 host 内 reporter 上报布尔值）。
- Storyboard 调试页（`/storyboard-debug`）每次提交先 `POST /api/conversations`（`agentId: "storyboard"`，带来源 `taskId`），拿到对话 id 后再 append 首条 user 消息发起运行；URL 参数 `conversationId` 用于刷新后读回历史。右侧「Workspace 文件」面板从 `GET /api/conversations/{id}/workspace/files|file` 只读；重拉时机 = 聊天流里工具结果条数 + 运行是否结束（TanStack Query key 的一部分），正文按 `version` 缓存。
- `DELETE /api/projects/{projectId}` 删除项目文件夹，删除成功后前端从首页最近项目列表移除对应项目。
- 普通 AG-UI run 使用官方 `threadId` 字段，值必须等于服务端发放的对话 id，不得使用项目文件夹 id 替代。
- Storyboard run 固定使用 `STORYBOARD_AGENT.runUrl`（`/api/agents/storyboard/chat`）；前端只配置 `threadId=对话 id` 和这个 URL，参考素材作为 `file` part（`data` 为 HTTP 地址）随首条消息发送，媒体换形状由服务端做。
- 断线不自动重发 `startRun`：本仓后端的运行不绑在请求上，再 POST 一次是开新运行；传输中断只呈现为错误，刷新页面从存档读回。

### Tests Required

- 公开 API 用例覆盖 Project 创建不含 target、VideoTaskSession 创建与按 Project 列表、AG-UI run 使用正确 Session。
- 首页 Agent project 卡片断言 `href=/projects/{projectId}`，且点击卡片不创建、不选择 session。
- 首页 Storyboard project 卡片断言 `href=/storyboards/{projectId}`，并且列表只包含存在显式 VideoTaskSession 的 Project。
- Storyboard 页面用例覆盖多条关系映射为多个 Storyboard、添加 Task 创建新关系、切换后输出仍属于各自 `sessionId`。
- `ProjectRoute` 初始加载断言调用 `listProducerProjectSessions(projectId)`，只使用与当前 AG-UI target id 匹配的 sessions 挂载 runtime；没有匹配 session 时正向创建一个当前 target session。
- `/agents/<id>` override 覆盖 `PRODUCER_AGUI_TARGET` 的 `id/path/apiPrefix` 派生；target path normalize 覆盖缺少开头斜杠和带末尾斜杠，Storyboard 用例固定消费 `STORYBOARD_AGENT`。
- Storyboard 调试页用例覆盖：提交先 `POST /api/conversations`（带 `agentId: "storyboard"` 与 `taskId`），随后 `POST /api/agents/storyboard/chat` 的 `threadId` 等于返回的对话 id；传输中断不触发第二次 POST。

## 视频生成提交

### 1. Scope / Trigger

修改视频提示词确认、单镜头/画布视频生成按钮、`src/features/projects/api/producer-project.api.ts` 的 video-generations 提交或 `CanvasVideoWorkspace` 时读取本节。

### 2. Signatures

- 统一提交端点：`POST /api/video-generations`，请求体 `{ assetType: "video", requestPayload: { inputs: Array<{ kind: "url"; mediaType: "image" | "video" | "audio"; url: string }>, model, params: { aspectRatio: string; durationSeconds: number; shotIndex?: number }, prompt: string, type: "video" }, scope }`。
- `scope` 二选一：`{ type: "project", projectId }`（Direct 画布）或 `{ type: "session", sessionId }`（Agent Workspace artifact 内提交）。
- Frontend helpers：`submitProjectVideoGeneration(projectId, input, { signal }?)` 与 `submitSessionVideoGeneration(sessionId, input, { signal }?)`；输入的 `referenceImages` / `referenceVideos` / `referenceAudios` 经 `splitVideoGenerationReferenceUrls()` 从附件 URL 拆分。

### 3. Contracts

- 视频提示词默认只读展示；用户点击“修改”后才进入 textarea 编辑态。
- 前端提交的是当前镜头本地草稿中的 prompt；保存时先重新读取 `video_shot.json` 获得最新正文与 ETag，只替换对应镜头 prompt。
- Workspace 修改成功后的根目录 `video_shot.json` 是提示词节点权威输入；PUT 必须原样携带读取时的 `If-Match` ETag，412 冲突显式暴露。组件草稿随最新 `videoPrompt` 内容同步，不保留 dirty draft 保护。
- Agent video-prompt artifact 内提交时，`shotIndex` 使用当前视频提示词 batch 的 `index`；`durationSeconds` 使用当前 batch 的 `second`；`aspectRatio` 来自当前 video-prompt artifact 的 `aspectRatio`；参考图使用当前镜头预览图 URL，暂无视频参考时提交空的 `referenceVideos`。
- Direct Canvas workspace 提交时，`aspectRatio` 与时长必须来自 Direct composer 当前视频设置，默认由 `DEFAULT_VIDEO_GENERATION_SETTINGS` 提供；时长控件是整数秒滑块。
- Direct Canvas workspace 提交前必须复用 composer 附件上传能力，把本地图片/视频上传为远端 URL 后再按 `mediaType` 拆入 `inputs`；附件上传失败必须显示错误并阻止提交。
- Agent artifact 提交成功后必须合并本次 generation 并刷新 Session Workspace、assets 与 generations，让 generated-video artifact 进入画布状态和后台轮询；Direct Canvas 提交成功后只写入 route-local 任务列表并显式同步 `video-generation-task` 节点到 `project-canvas` store。
- `project-canvas` store 在 Direct Canvas 中只承载同步后的 `video-generation-task` 节点、当前页面布局、选中和缩放；项目坐标的远端持久化由 Direct Canvas 专用 coordinator 衔接 TanStack Query 完成。store 不得从 AG-UI state、Agent timeline 或 session runtime 派生 Direct task 数据。
- `video_shot.json` 恢复 video-prompt 时只接受 `{ aspect_ratio, shots }` 根对象；shot 的 `image_urls` 必须是数组但允许为空，空数组镜头仍要渲染并以空参考图提交。

### 4. Validation & Error Matrix

| 条件 | 正确处理 |
| --- | --- |
| 未登录（cookie 失效） | 后端 401，经全局未授权处理回登录 |
| prompt trim 后为空 | 前端阻止提交并提示 |
| 缺少 `aspectRatio` 或时长 | 前端阻止提交并提示 |
| 后端返回非 2xx | helper 读取 `detail/error/message/cause` 并抛“提交视频生成任务失败” |
| 成功响应 task status 非法 | helper 视为响应格式错误 |

### 5. Tests Required

- API helper：断言端点 URL、请求体（含 `scope` 分支）、`credentials: "same-origin"`、响应映射和错误格式化。
- UI：断言点击“修改”后 textarea 修改的 prompt、当前镜头预览图 URL、`shotIndex`、时长和 `aspectRatio` 一并提交，并覆盖 Workspace GET ETag → PUT `If-Match` → 刷新提示词节点、不保留旧本地草稿。

## AG-UI 聊天运行态

### Scope / Trigger

修改 `src/features/chat/**`（`ProjectChatProvider`、assistant-ui AG-UI runtime adapter、state adapters、聊天 timeline、HITL、tool log、composer 附件）或画布自动布局时读取本节。

### Signatures

- `Message.id`：后端 AG-UI 原始消息 id，opaque，不是前端展示轮次。
- `RunAgentInput.runId` / `RUN_STARTED.runId` / `RUN_FINISHED.runId`：运行 id，opaque，不得设为或推导为 `turn-N`。
- `RUN_STARTED.rawEvent.run_id`：后端诊断用的源 run id；前端不得读取它定位恢复流、维护游标或派生 runtime 状态。
- `ProjectChatTimelineItem.id`：前端 React key，必须直接来自后端 `message.id`、`toolCallId` 和 part index，不得使用前端派生 `turn-N`。
- `ProjectChatProvider.timelineItems`：聊天侧栏唯一对话投影，按消息历史生成连续可滚动 timeline，不维护 `turns`、`selectedTurn` 或 `runningTurnId`。
- `ProjectAssistantRuntimeProvider`（`features/chat/agui/provider.tsx`）：项目页唯一 assistant-ui AG-UI runtime provider，是通用装配 `shared/agui/provider.tsx`（`AguiConversationRuntimeProvider`）的薄包装，只补 producer team 特有的成员事件消费与 restore 成员历史注水。`threadId` 固定等于当前 `sessionId`；原厂 `HttpAgent` 单 URL，无 runtime 换代。传输层错误归一在 `shared/agui/transport.ts`（断网、无终止事件的 EOF → 一个错误交给 `onError`），**没有自动重连**：本仓后端再 POST 一次就是开新运行。Storyboard 复用同一通用装配（ADR-0006）。
- `features/chat/agui/history.ts`：restore 信封解析与加载（官方 `ThreadHistoryAdapter` 由 `shared/agui/provider.tsx` 内建，restore 注水 + 透传后端唯一恢复决策 `activeRun`）；不得保存 backend run id、event cursor、消息/工具开合账本或任何前端重连判定。
- `useAuiState((state) => state.thread.state)`：Project Chat 业务层读取当前 AG-UI state 的唯一入口；messages 与运行状态分别直接读取 `state.thread.messages` 和 `state.thread.isRunning`。
- `ProjectRoute.activeSessionId`：当前项目页可见 session；只控制哪个 session workspace 被渲染，不承载聊天 messages、interrupts 或恢复状态。
- `ProjectRoute.sessionIndicators`：项目层唯一 session 状态摘要表，只允许表达 `reviewed`、`running`、`hitl`、`unread`；不得保存 session messages、pending interrupts 或 replay 位置。
- `ProducerProjectSession.runtimeStatus`：后端返回的 session 运行摘要，只能是 `completed`、`running`、`hitl`；项目 tab 初始状态和后台订阅集合从这里派生。
- `ProjectRoute.subscribedSessionIds`：当前挂载独立 AG-UI runtime 的 session 集合；由 active、后端或本地 `running`、后端或本地 `hitl`、recent session 派生。
- run 端点：`POST /api/agui/teams/producer`（`AGUI_RUN_ENDPOINT`，唯一 SSE 端点，服务端归因）；历史恢复：`POST /api/agui/teams/producer/restore`（`AGUI_RESTORE_ENDPOINT`，JSON + `activeRun` 决策）；取消：`POST /api/agui/teams/producer/runs/{runId}/cancel`。run 只接收官方 `RunAgentInput`，重连的 backend run 只由后端归因定位。
- 业务状态事实源：Workspace 产物走 `GET /api/sessions/{sessionId}/workspace/files` + `GET /api/sessions/{sessionId}/workspace/file?path=...`；媒体与生成任务走 `GET /api/sessions/{sessionId}/assets|generations`。不消费 AG-UI state 作为业务事实源。
- 重连：恢复决策只来自 restore 响应的 `activeRun`（非 null → 注水后自动触发一次普通 `startRun`，后端归因为 attach）；前端不查 runs list、不做本地判定。传输中断与 `ACTIVE_ELSEWHERE` 同治：退避后重发普通 `startRun`，回放事件按 messageId 幂等吸收，无 frozen/warming 换代。重连期间发送框禁用（服务端 `RUN_IN_PROGRESS` 为第二道防线）。Team member child runs 不参与 session 状态判定。HITL continuation 断线不得重发一次性 `resume[]`，只通过归因 attach 观察已提交 run 的结果。
- `RunAgentInput.resume[]`：HITL continue 使用 assistant-ui AG-UI runtime 的 resume 协议回到同一 run 端点，不走单独 HITL 接口。
- restore message 的 `metadata.custom.agui.interrupts` 与 live `RUN_FINISHED.outcome.interrupts[]`：当前待处理 HITL。restore 的 metadata、placeholder 和 ask tool-call anchor 均由后端组装，`fromAgUiMessages()` 恢复为 assistant-ui pending 状态；前端只用 `toolCallId` / `targetId` 定位 ask 或 approval，不要求或推导 `turnId`。多个 pending interrupts 必须逐个展示、在前端本地暂存 response，并按 `@assistant-ui/react-ag-ui` runtime 的公开接口要求，在全部完成后一次性提交完整 `resume[]`。
- `listProducerSessionWorkspaceFiles()` / `readProducerSessionWorkspaceFile()` / `replaceProducerSessionWorkspaceFile()`：Workspace 列表、读取与 CAS 完整替换的唯一 frontend seam。读取和修改响应均要求 opaque ETag，PUT 用 `If-Match` 原样回传。
- `WorkspaceDocument = { path, content, etag }`：`path` 是后端 canonical 逻辑路径，Workspace artifact identity 为 `workspace:${path}`；`content` 只来自 read 端点。
- 可见 Workspace documents：`path` 以 `.md` / `.markdown` / `.mdx` 结尾，或精确等于根目录 `video_shot.json`。后端 list 顺序保留到画布投影。
- `image/{assetId}.md` / `video/{assetId}.md`：path basename 是 session AssetId，必须精确关联 `source = upload | import` 且媒体类型一致的 asset；未知 asset、generation output 或类型不一致都显式失败。
- Workspace 写入工具的成功结果 `{ message, path }` 只是失效通知；`toolCallId + path` 只用于识别新的已完成写入并触发全量 Workspace 重读，不从 result 提取正文。

### Contracts

- 前端不得再生成、传输或依赖 `turn-N` / `turn_id` / `turnId` 作为聊天、HITL、tool log 或 artifact 身份。
- 从 AG-UI messages 构建聊天 UI 时，直接生成连续 `ProjectChatTimelineItem[]`：user message、assistant bubble、tool-log segment、ask 和 subagent flow 是同一层 siblings；active run 等待态只能表达为单一可移动 assistant-bubble response shell。
- timeline item key 必须稳定唯一：user 使用 `user:${message.id}`，assistant/tools 段使用 `${kind}:${message.id}:${partIndexBase36}`，ask/subagent 使用 `${kind}:${toolCallId}`；同一 `toolCallId` 的 ask 结果必须 upsert 到原位置，不能追加重复节点。
- 项目页消息运行态交给 `@assistant-ui/react` + `@assistant-ui/react-ag-ui`；`ProjectChatProvider` 不维护平行完整 message runtime、手写 subscriber 或自定义消息合并账本。
- restore adapter 必须把 payload 的 `state` 直接放进 assistant-ui history repository；`useAgUiRuntime` 在加载 repository 时统一 hydrate messages 与 state。不得再建立 `ProjectAguiStateContext`、订阅 `onStateChanged` 复制第二份 state，或通过 `threadRuntime.importExternalState()` 把同一 state 导回 runtime。
- `ProjectChatProvider` 直接通过 `useAuiState` 读取 assistant-ui thread state、messages 与 `isRunning`；Session Workspace、assets 与 generations 刷新只更新 artifacts、media、generation records 与相关错误，不负责复制或导入 AG-UI state。
- 一个 project 下多个 session 必须表现为多个独立 `ProjectChatProvider(sessionId)` runtime host；不得创建 project-level AG-UI multiplex stream，也不得在 project 层 demux 不同 session 的 AG-UI events。
- Project 层只管理 session 列表、`activeSessionId`、`sessionIndicators` 和订阅集合。Session messages、assistant-ui thread state、pending interrupts 与连接恢复状态机只属于对应 `ProjectChatProvider(sessionId)`。
- Session runtime 订阅策略固定为 active + running + hitl + recent。running/hitl 初始来自后端 `ProducerProjectSession.runtimeStatus`；已挂载 runtime 先上报 `running`/`hitl` 后，本地 `reviewed` 才能覆盖后端运行摘要。project 层不得为了探测状态引入 unknown/initialized 订阅，也不得让 runtime 尚未 hydrate 时的非运行观察结果抢先卸载后端标记为 running/hitl 的 session。
- 切换 active session 只切换可见 workspace；如果目标 session 已在订阅集合内，不得重新 restore 或重建 runtime。未订阅的 completed session 被切换为 active 时再挂载 runtime 并走 restore。
- 后台 session 从 `running` 变为 `reviewed` 且不是当前 active session 时，project 层标记为 `unread`；用户切到该 session 后清除 unread。active session 完成时不得标记 unread。
- Producer 只维护项目标题、Session Workspace / assets / generations 派生的媒体与分析产物、active HITL interrupt、未提交的多 interrupt 本地 responses、canvas 可见产物、composer 上传与错误恢复、连续聊天 timeline。
- 初始加载只通过 restore JSON 恢复 history：后端已经把 paused interrupts、placeholder 和 ask tool-call anchor 组装进 AG-UI messages；前端以官方 `fromAgUiMessages()` 恢复标准消息、metadata/status（user 消息的文本/媒体 part 交错顺序原位保留为 content parts，媒体不折叠为尾部附件——patch 行为，见 `patches/@assistant-ui__react-ag-ui@0.0.44.patch`），只后处理 Productor 特有的成员工具结果归属、内部 confirmation 过滤和孤立 tool result 过滤。restore payload 的 state 与 history repository 一起交给 assistant-ui hydrate。
- active local run 期间 stream 拥有 assistant-ui runtime messages 与 state；Session Workspace、assets 与 generations 刷新只能更新 artifact、media、generation records 和错误状态，不得 reset live messages、覆盖 thread state 或恢复 interrupts。
- RUN_FINISHED 后只刷新业务 state 与项目元数据；消息历史由 live AG-UI stream 负责收敛，不从任何刷新接口重置 runtime messages。
- Producer media 和分析 artifact 只能从 session assets、generations 以及 Session Workspace list/read 恢复；输入媒体只接受 `source = upload | import`。
- `ProjectChatProvider.artifacts` 只使用 Session Workspace documents、session assets 与 generations 解析出的持久化 artifacts；不得从 `timelineItems`、AG-UI `messages`、assistant message `data-*` parts、tool result 正文或 response shell 中派生画布 artifact。
- Workspace document 只有 `path` 以 `.md` / `.markdown` / `.mdx` 结尾时，才恢复为 `kind: "markdown"`；标题从 canonical path 的文件名去掉扩展名后推导，不写死 brief/storyboard 等展示标题。
- 根目录 `storyboard.md` 与其它可见 Markdown 一样展示；不得从 Markdown 表格自定义解析分镜。
- 只有根目录 `video_shot.json` 可结构化为 `kind: "video-prompt"`；无法解析或无法结构化时显式记录投影错误，不 fallback 为 Markdown，也不能从消息中的 `data-video-prompt` 或 `data-storyboard` 补产物。
- AG-UI `state` 是官方 generic state，restore 与 live snapshot 均按 runtime 默认行为透传；前端不得要求、注入或解释 Producer 私有命名空间。
- 普通 run 与 HITL continuation 均由后端固定 `background=True`；前端不得通过 `forwardedProps.background` 控制后台执行。任意 live stream 的真实 transport 中断都进入 `interrupted` 并退避重发普通 `startRun`（后端归因 attach）；HITL continuation 只观察后台同一 run，绝不自动重发 `resume[]`。
- 普通 run 不传递前端 turn metadata；assistant-ui 放入 `forwardedProps.runConfig` 的前端私有字段必须在桥接层删除。
- HITL continue 不构造 fake user/tool message；必须通过公开 `useAgUiSubmitInterruptResponses()` 提交 AG-UI resume payload，不得恢复旧的独立 HITL 接口或 `unstable_*` runtime 访问。
- `RunAgentInput.resume[]` 只用于一次性 HITL continuation；重连触发的 `startRun` 不携带或重放该数组。
- 本地乐观 user message 的 AG-UI `id` 必须是 opaque，不得使用前端派生 id。
- restore JSON 的 `messages` 必须返回可恢复的后端 AG-UI message 历史；前端不得向后端快照插入本地 user message。
- active interrupt 只通过公开 `useAgUiInterrupts()` 读取 assistant-ui runtime pending interrupts；来源为 restore message metadata 或 live `RUN_FINISHED.outcome.interrupts`，不得把 `state._required.activeRequirements` 作为状态源。当 pending interrupts 多于一个时，提交当前项只写入本地 staged response；只有全部 pending interrupt 都有 response 时才调用 `useAgUiSubmitInterruptResponses()` 返回的提交函数。这一完整覆盖要求来自官方 assistant-ui runtime，前端不在其外再复制一套验证。
- `producerSessionWorkspaceSourcesToSnapshot()` 从 Session Workspace documents、session assets 与 generations 展平媒体库与 artifacts；item 缺少可展示 URL 时不生成媒体 tile。
- video output 的 running/processing/queued 记录仍可生成 generated-video artifact，驱动后台轮询。
- `image/{assetId}.md` 按 path 中的 AssetId 精确关联 input image，并聚合为一个固定领域 id 的图片分析 artifact；画布节点外框统一使用 16:10 固定尺寸，图片解析内容在节点内部滚动，不按单图拆 Markdown 节点。
- `video/{assetId}.md` 按 path 中的 AssetId 精确关联 input video；视频解析、Video Brief 等 Workspace Markdown 保留服务端产出的富 Markdown / HTML，由统一 rich Markdown renderer 渲染。测试只锁定来源选择、path 关联和 renderer 边界/行为，不通用快照或限制正文格式。
- 普通 Workspace artifact 身份为 `kind + workspace:${path}`；图片分析汇总与 generated-video 使用各自固定领域 id，不依赖 `messageId` 或 `toolCallId`。
- 聊天侧栏只通过连续 `ProjectChatTimelineItem[]` 渲染历史，不恢复 `assistantMessage`、`assistantText`、`toolLogs` 或 `ProjectChatTurn` 扁平字段。
- timeline item 覆盖 `user-message`、`assistant-bubble`、`tool-log-segment`、`ask-user-question` 和 `subagent-flow`；不得再生成 `answering-indicator`；timeline 只负责聊天渲染，不负责 artifact 提取。
- 承载真实内容的 `assistant-bubble` 和 `tool-log-segment` timeline item id 必须包含后端 `Message.id` 和段起始 `partIndex`；response shell 使用固定本地 id；ask/subagent id 必须包含 `toolCallId`。
- active run 期间最多存在一个 `assistant-bubble` response shell：最新可见节点是 user message、普通 tool log 或 subagent flow 时，shell 移动到该节点之后；最新可见节点是 active 或 historical `ask-user-question` 时隐藏 shell；最新可见节点是正在流式的 assistant 正文时复用该 assistant bubble，不额外插入 shell。
- response shell 的 `message.parts` 必须保持真实模型内容边界：空 shell 不写入“正在回答”文本，不进入 AG-UI message、artifact 提取或模型消息 parts；“正在回答”只由渲染层根据 `isResponseShell && message.parts.length === 0` 展示。
- assistant response shell 的 `agentKind` 由 active speaker 推导：普通 run、用户消息和普通工具为 `producer`；`delegate_task_to_member.member_id = creative-director` 运行中为 `creative-director`；`member_id = storyboard-director` 运行中为 `storyboard`；对应子 agent completed/failed 后切回 `producer`；未知成员降级为 `producer`。
- 对话面板渲染 assistant-ui 投影 message parts：text 用 markdown renderer，reasoning 默认折叠且运行中展开，file 正常展示；tool-call part 本身不进 assistant 气泡。
- 普通 tool 生命周期事实源只允许是 AG-UI messages：`assistant.toolCalls[].id` 与后续 `role="tool".toolCallId` 完全匹配表示该 tool 已结束。
- AG-UI message snapshot 的标准消息、tool result、error/status 与附件转换统一交给官方 `fromAgUiMessages()`；Productor 只在转换前用 `member_id` 消歧重复的 `delegate_task_to_member` toolCallId，转换后恢复原始 id，并过滤内部 confirmation 与孤立 tool-result assistant message。
- 未匹配任何 assistant tool call 的 `role="tool"` message 是无效历史，不得合成 fake assistant message，也不得进入普通聊天 timeline。
- `projectToolStateFromAssistantPart()` 只消费已规范化的 assistant-ui part：`isError` 优先映射 failed，其次 `result !== undefined` 映射 completed，其次 running assistant message 映射 running，最后才是 started。
- Workspace 写工具的 `{ message, path }` 只触发 canonical path 的业务数据重新读取，不参与普通 tool log started/completed/failed 判断，也不提供 artifact 正文。
- 后端完成普通 tool 时必须返回带匹配 `toolCallId` 的 `role="tool"` message；缺失或孤立 tool result 不做前端兼容。
- 普通 tool log 默认从所有非特殊 assistant-ui tool-call 生成；`ask_user_question`、`delegate_task_to_member` 和 `confirm*` 继续走专用 timeline 组件或内部协议过滤，不进入普通 tool log。已知工具必须提供中文 action 映射：`get_skill_instructions`、`get_skill_reference`、`image_parser`、`video_parser`、`read_file`、`list_files`、`search_content`、`write_file`、`edit_file`。未知普通工具不得静默丢弃，必须以原始 tool name 生成可见日志。
- 连续普通工具合并为 `tool-log-segment`，默认一行、点击展开多行；遇到文本、ask 或子 agent 特殊组件时必须结束当前工具段。
- `ask_user_question` tool call/result 必须保留为 `ask-user-question` 历史节点；active ask 根据 `activeInterrupt` 在同一 `toolCallId` timeline 位置替换成可交互表单。restore 的 pending ask metadata、placeholder 和同 message 的 assistant tool-call anchor 均由后端 contract tests 保证；前端不重复校验，也不得 materialize fake tool-call 或把新一轮 pending ask 绑到旧 user turn。
- `delegate_task_to_member` 不进入普通工具 log；`member_id = creative-director` 展示为“创意策划师”，`member_id = storyboard-director` 展示为“分镜执行导演”，使用本地 Agent 头像身份牌，成功 result 追加“<成员名>已完成任务”。
- UI 不展示 raw tool name、`creative-director`、`storyboard-director`、JSON 参数、skill name、reference path 或内部协议字段；未知 ask 来源标签统一降级为“工具确认”。
- 不恢复旧标题行、prompt card、单轮 `assistantText` 主显示、手写 markdown parser 或底部独立 AgentLog 面板。
- 内联 ask 面板只在 `activeInterrupt.kind === "ask_user_question"` 且 `targetId/toolCallId` 匹配当前 timeline item 时展示。
- Composer 本地附件只在提交草稿时上传；选择、预览、排序、删除阶段不得调用 OSS 上传。
- 提交本地图片或视频前，必须先通过 OSS 预签名上传（`POST /api/presign`）拿到 `publicUrl` 和 `contentType`，再写入 AG-UI messages、进入 streaming 或调用 `runAgent`。
- `delivery: "remote"` 的 composer 附件不得重新上传，提交时保留已有 URL。
- 纯文本 user message 的 AG-UI `content` 保持字符串；带附件 content 使用 runtime helper 构造成多模态数组，文本 part 在前，URL-source 图片/视频 part 在后。
- AG-UI content 和本地插入的当前 user message 中不得出现 `blob:`。

### Validation / Cases

| 条件 | 正确处理 |
| --- | --- |
| run id 任意 opaque 字符串 | 正常接受，run id 不参与前端展示身份 |
| 后端 messages 少于当前运行所需 user message | 视为后端未收敛，不插入本地消息、不推导额外轮次 |
| 后端 messages 已包含未完成 user message | 直接用后端 messages 构建连续 timeline |
| `assistant.toolCalls[].id` 与后续 `role="tool".toolCallId` 匹配 | 将 tool result 注入对应 assistant-ui tool-call part，并把普通 tool log 显示为 completed |
| 匹配到的 `role="tool"` 带 `error` 或 `isError` | 将对应 assistant-ui tool-call part 标记为 failed，不显示 running |
| `role="tool"` 没有匹配的 assistant tool call | 视为无效历史并丢弃，不合成 fake assistant message |
| active local run 期间 Workspace/assets/generations 刷新先返回 | 只同步 artifact、media 和 generation records，不 reset live messages 或覆盖 assistant-ui thread state |
| RUN_FINISHED 后 final/convergence 刷新返回 | 只刷新业务 state 与项目元数据，不 reset runtime messages |
| HITL continuation 在收到 `RUN_STARTED` 后断线 | 不再次提交 `resume[]`，也不自动重发 `startRun`；后台 run 由后端持有 |
| restore 返回 409（多在途 run / paused 无 requirement） | 直接暴露协议错误，不静默降级成普通历史 |
| transport 中断但旧页面仍在 | `shared/agui/transport.ts` 收敛为一个错误交给 `onError`，呈现为错误；**不自动重发 `startRun`**（再发一次是开新运行） |
| 后端返回 `RUN_ERROR RUN_INTERRUPTED` | 服务端进程没跑完就没了；按普通失败呈现，由用户决定是否重新发起 |
| 后端返回 `RUN_ERROR RUN_IN_PROGRESS` | 消息标记未送达留在本地；绝不静默丢弃 |
| 后端返回 `RUN_ERROR ACTIVE_ELSEWHERE` / `CANCELLED` | `@assistant-ui/react-ag-ui` 补丁映射为 `RUN_CANCELLED`，呈现「已停止」中性终态，不按错误处理 |
| restore pending ask interrupt 已写入 message metadata | `fromAgUiMessages()` 恢复 `requires-action`，公开 interrupt hook 生成 active interrupt 和 resume payload |
| 后端 restore contract 缺本轮 assistant 或 ask anchor | 后端契约测试失败；前端不合成、修复或交叉校验 placeholder / fake tool-call |
| `ask_user_question` 已回答后刷新历史 | 保留为“工具确认”历史卡片，并展示每题答案 |
| `get_skill_reference` 工具调用 | 进入普通工具日志并显示“制片人加载创作参考”，不展示 reference path |
| 普通工具出现在 ask 或 subagent 前后 | 按 timeline 切成多个 `tool-log-segment`，不得跨特殊组件合并 |
| `delegate_task_to_member` 指向 `creative-director` | 展示创意策划师头像身份牌、“制片人将任务交给创意策划师”和“已交接”；成功 result 展示“创意策划师已完成任务” |
| `delegate_task_to_member` 指向 `storyboard-director` | 展示分镜执行导演头像身份牌、“制片人将任务交给分镜执行导演”和“已交接”；成功 result 展示“分镜执行导演已完成任务” |
| Workspace document 没有历史轮次 | artifact 只使用 `kind + workspace:${path}` 身份，不补 `turn-1` |
| 多个输入图片有 `image/{assetId}.md` | 聚合成一个固定领域 id 的图片分析节点 |
| media item 缺可展示 URL | 不进入媒体库 tile；video output 进度 artifact 可保留 |
| Workspace document `path` 后缀明确为 Markdown | 生成 Markdown 节点，标题使用 canonical path 文件名 |
| Workspace document 是非 Markdown 且不是根目录 `video_shot.json` | 不读取、不生成画布 artifact |
| 根目录 `video_shot.json` 解析失败或无法结构化为 video-prompt | 记录明确投影错误，不 fallback 为 Markdown |
| AG-UI state 是任意合法 JSON object | 交给官方 runtime 透传，不要求 Producer 私有字段 |
| 本地附件上传失败 | 恢复草稿并显示包含附件名的错误，不插入 user message，不启动 run |

### Tests Required

- 聊天 hydrate：后端返回 UUID user message 后可直接生成连续 user-message timeline item；不得补本地 `turn-N` message。
- 聊天 timeline：普通文本气泡、普通工具分段、ask 历史/active 原位置、重复 ask upsert、response shell 单例移动、ask 隐藏、子 agent speaker 切换、真实成员 id 的中文映射、raw 字段不泄露。
- Producer 业务数据 hydrate：媒体库来自 session assets/generations，输入媒体只接受 `source = upload | import`；Workspace list 顺序保留，read 返回的 `{ path, content, etag }` 生成 artifact；`image/{assetId}.md` 聚合为固定领域 id 的图片分析，根目录 `video_shot.json` 恢复视频提示词，普通 artifact 身份为 `kind + workspace:${path}` 且不携带 `turnId`。
- Workspace 写入刷新：已完成工具结果 `{ message, path }` 触发 list/read 重取并使用 ETag；result 正文不成为 artifact 内容，重复通知不重复刷新。
- generic AG-UI state：restore 与 live `STATE_SNAPSHOT` 可包含任意合法对象且不含 Producer 私有字段，assistant-ui runtime 仍能正常 hydrate 与更新。
- 富文本 artifact：视频解析与 Video Brief 的富 Markdown / HTML 经统一 renderer 呈现；测试覆盖安全/渲染边界，不对服务端正文格式做通用快照锁定。
- active interrupt：ask panel 只按 `targetId/toolCallId` 匹配，不按 turn 匹配；restore message metadata 必须能恢复为 active ask panel 并提交 selections resume；多个 pending interrupts 必须按 runtime pending 顺序逐个处理，最终 resume payload 保持同一顺序。
- HITL interrupt hydrate：restore message metadata 或 live `RUN_FINISHED.outcome.interrupts[]` 可没有 `turnId`，前端不得反查或推导 turn。
- 普通 tool 生命周期：按 `toolCallId` 配对完成/失败、孤立 tool result 丢弃、active run 期间 Workspace/assets/generations 刷新不清掉 live message。
- composer 附件：local 图片/视频上传、remote 不上传、上传失败不启动 run、纯文本 content 是字符串、带附件 content 不含 `blob:`。
- assistant-ui runtime 桥接：`threadId=sessionId`、普通 run 不带 `turn_id`、HITL resume 走同一 run 端点、continuation 断流不重发 `resume[]`、rejoin body 无 backend run/cursor 私有字段、ready 前后 runtime 原子切换、图片/视频 URL-source、历史 AG-UI messages 转 assistant-ui parts。

### Wrong vs Correct

```ts
const localTimelineId = `message-${messages.length}`;
```

```ts
const assistantSession = createProjectAssistantSession({
  sessionId,
  onRestoredMembers,
});
const aguiState = useAuiState((state) => state.thread.state);
const timelineItems = projectConversationTimelineItemsFromAssistantMessages({
  messages: threadMessages,
  activeInterrupt,
  isRunning: threadIsRunning,
});
const projectSnapshot = producerSessionWorkspaceSourcesToSnapshot({
  data: { workspaceDocuments, assets, generations },
});
```

## Project Chat Context 订阅边界

### Scope / Trigger

修改 `src/features/chat/state/ProjectChatProvider.tsx`、`useProjectChat*` hooks、项目页 Header、Composer、聊天侧栏、画布资源同步或画布节点组件时读取本节。

### Contracts

- Project Chat 不提供全量 `useProjectChat()` 兼容入口，也不维护聚合全部字段的 Context。项目页真实 UI 与测试观察器都必须使用最窄的专用 hook：活动摘要用 `useProjectChatActivity()`，标题用 `useProjectChatTitle()`，当前 interrupt 用 `useProjectChatActiveInterrupt()`，画布资源桥用 `useProjectChatResources()`，视频提示词节点用 `useProjectChatVideoGeneration()`，ask 提交用 `useProjectChatAskUserQuestion()`，composer 用 `useProjectChatComposer()`，聊天侧栏用 `useProjectChatConversation()`。
- 不定义 `ProjectChatStatus = "ready" | "submitted" | "streaming" | "error"` 这类平行生命周期枚举。`useProjectChatActivity()` 只返回 `{ hasError, isHydrated, isInteractionLocked }`：`hasError` 表示当前项目聊天存在已分类并展示的错误，`isHydrated` 由 assistant-ui thread state 是否完成首次 restore 派生，`isInteractionLocked` 由提交准备阶段或 assistant-ui `thread.isRunning` 派生；调用方不得根据字符串 status 再实现一套运行状态机。
- 后台 session 在 `isHydrated=false` 且没有错误时不得向项目层上报 `COMPLETED`，以免覆盖 AgentOS 的 `RUNNING/PAUSED` 摘要并在 rejoin 前卸载 runtime。
- 需要提交能力的窄 hook 可同时暴露 `isInteractionLocked`，用于统一禁用 composer、ask 和视频生成交互；运行中与提交准备中的区别留在 Provider implementation 内，不扩散到调用者 interface。
- 业务状态刷新后，只有对应状态片段变化的 context value 可以变更引用；等价的 `artifacts`、`projectMedia`、`activeInterrupt`、runtime messages 和 assistant-ui thread state 必须复用旧引用或 no-op。
- 画布主体、Header、Composer、聊天侧栏和节点组件的订阅边界必须互相独立：timeline 更新不得让画布资源桥或视频提示词节点重渲染，普通 media 更新不得让 Header 或聊天侧栏因全量 context value 变化重渲染。

### Tests Required

- Provider 或项目页 context 调整时，至少跑 `project-chat-provider`、`project-conversation-panel`、`project-canvas-store` 和受影响组件单测。
- 新增 UI 组件如果引入聊天上下文，测试或 code review 必须确认它使用专用窄 hook；不得新增聚合 Context 或全量观察入口。

## Project Canvas 布局与项目级持久化

### 1. Scope / Trigger

修改 `src/features/project-canvas/**`、画布节点位置持久化、节点拖拽提交、媒体/analysis artifact 同步或画布测量重排时读取本节。

### 2. Signatures

- `ProjectCanvasLayoutMode = "auto" | "manual"`：画布节点唯一布局模式。
- `BaseProjectCanvasNodeData.layoutMode: ProjectCanvasLayoutMode`：每个 React Flow 节点必须显式携带布局模式。
- `resolveProjectCanvasMasonryLayout(options)`（`layout/project-canvas-masonry-layout.utils.ts`）：纯函数布局器，只接收节点矩形、边界、列宽和 gap，不读取 DOM、React 或 Zustand。
- `commitManualNodePositions(positions): { accepted: boolean }`：拖拽停止后的唯一手动坐标提交入口。
- `ProjectCanvasLayoutNode = { nodeId: string; layoutMode: ProjectCanvasLayoutMode; x: number; y: number }`：可持久化的单节点布局事实。
- `ProjectCanvasLayout = { schemaVersion: 1; revision: number; nodes: ProjectCanvasLayoutNode[]; updatedAt: string | null }`：后端返回的项目布局快照。
- `getProducerProjectCanvasLayout(projectId, { signal }?)`：读取 `GET /api/projects/{projectId}/canvas-layout` 的 `{ layout }` envelope。
- `replaceProducerProjectCanvasLayout(projectId, input, { signal }?)`：以 `{ schemaVersion: 1, expectedRevision, nodes }` 完整替换布局快照。

### 3. Contracts

- 后端 `project_canvas_layouts` 是项目布局的唯一事实源；前端不用 localStorage/sessionStorage 保存画布节点位置，后端读写失败时也不得静默 fallback 到本地快照。
- React Flow 只负责节点渲染和拖拽事件；Zustand `project-canvas` store 只持有当前页面的可交互节点、坐标与布局不变式；TanStack Query 负责服务器布局的读取、替换、revision 与请求状态。三者不得各自维护一份布局事实。
- Direct Canvas 使用专用布局 coordinator 衔接 TanStack Query 与 `project-canvas` store：coordinator 负责先读取并 hydrate 服务器快照，再在 store 发出语义提交后保存快照；它不另存一份节点坐标。
- 本阶段只有 Direct Canvas 挂载远端布局 coordinator。Agent workspace 仍按 `sessionId` 挂载画布，不得仅因共用 `project-canvas` store 就宣称其已具备项目级远端位置持久化。
- `schemaVersion` 固定为 `1`。从未保存过的项目返回 `revision: 0`、`nodes: []`、`updatedAt: null`；不支持的 schema 在边界显式失败。
- PUT 必须提交当前已读取的 `expectedRevision` 和全部节点位置；保存成功后后端返回递增的 `revision`。revision 不匹配返回 `409 Conflict`，前端必须暴露冲突，不得静默覆盖或自动合并。
- 新建节点默认 `layoutMode: "auto"`；只有 `commitManualNodePositions()` 成功时才能变为 `manual`。
- `manual` 节点坐标优先级最高；artifact/media 同步、节点高度测量和 fit view/zoom 都不得改写 manual 坐标。
- `onNodesChange` 只更新拖拽过程中的内存位置，不发送网络请求。`onNodeDragStop` 调用 `commitManualNodePositions()`，只有成功提交才请求 coordinator 保存一次完整快照。
- 项目拥有的所有可移动节点（包括 Direct Canvas 故事板工作台节点）都必须由 `project-canvas` store 持有位置。`extraCanvasNodes` 只可用于不持久化的临时覆盖物，不得承载项目业务节点。
- 布局以稳定 `nodeId` 对应业务节点；`nodeId` 不得由当前数组下标、节点总数或可变排序派生。业务数据与布局 hydrate 完成后再做 reconciliation：已有 ID 恢复服务器坐标，新 ID 走自动布局，已消失 ID 不进入下一份快照。
- Direct Canvas 必须等 persisted generation facts 的首次读取成功后再挂载布局 coordinator；加载中的空数组不是“项目没有 generation”，不得据此删除服务器快照中的历史 revision 节点。
- coordinator 每次挂载都必须重新 GET；当前挂载的 GET 真正结束前不得用 Query cache hydrate 新 store，其他请求的 `setQueryData` 也不能冒充本次读取完成。已接受的布局 revision 只能递增，离开页面前启动的旧 PUT 晚于重进 GET 完成时，新页面仍须接受 PUT 返回的更高 revision，不得被较旧 GET 回写。
- PUT 的 `expectedRevision` 必须取当前 store 实际 hydrate 或成功保存过的基线 revision，不能直接取 Query cache 中尚未应用到 store 的更高 revision；否则会绕过 CAS 并静默覆盖该 revision 的内容。
- 409 的“加载最新布局”会显式丢弃点击前的本地布局提交；请求期间新增或删除的业务节点不属于被丢弃范围，reconciliation 必须使用响应到达时的最新业务节点集合并继续保存。请求期间若又发生拖拽等布局编辑，本次重载不得覆盖它，冲突保持到用户再次显式选择加载最新布局。
- 自动布局使用行序体积碰撞：`columnWidth` 固定取统一节点宽度 `PROJECT_CANVAS_STANDARD_NODE_SIZE.width`（1760），前 2 个列锚点无条件可用，第 3 个及以后必须满足 `x + node.width <= bounds.maxX`。
- 所有画布节点的 React Flow `style.width` 与 `style.height` 固定为 `1760 × 1100`（16:10）；节点内卡片必须占满外框，长内容放入 `nodrag nopan nowheel` 内部滚动区。
- 画布空白区域必须支持拖拽平移与滚轮平移；React Flow 保持 `zoomOnScroll={false}`，滚轮不得改变缩放。
- 自动节点按输入顺序依次寻找位置：先尝试当前行从左到右的 slot，再换到下一行；每行至少有两个 slot，只有屏幕宽度足够时才增加第三列及以后 slot。
- artifact 内容刷新、generated-video 状态刷新和普通项目媒体刷新必须保留已有节点坐标；增量同步时把已有节点作为固定矩形参与碰撞检测，只为新增节点寻找可用 slot。
- 等价的 artifact/media/state snapshot 必须复用当前引用或直接 no-op，避免无业务变化的刷新触发 React Flow 节点重建。
- 候选位置必须用矩形体积碰撞检测校验：节点矩形按 `gap / 2` 扩张边界，任一轴仍有正向重叠即视为碰撞；发生碰撞时只跳过当前 slot，不改变已放置节点和 manual 坐标。
- 用户拖拽提交使用 `d3-force` 局部碰撞微调：所有 `manual` 节点固定，`auto` 节点以当前位置为 anchor，被碰撞时只移动解除重叠所需的最小距离。
- 旧 masonry 最短列填充、按内容高度改变外框、`d3-force` 全局初始排序和测量后自动漂移逻辑不得恢复。

### 4. Validation & Error Matrix

| 条件 | 正确处理 |
| --- | --- |
| GET 的项目从未保存布局 | 接受 revision 0 的空快照，现有业务节点按自动布局安置 |
| envelope 有未知字段、schemaVersion 不是 1、节点重复或坐标非有限数 | 边界显式失败，不产生半成品布局 |
| PUT 的 `expectedRevision` 已过期 | 后端返回 409，前端保留未保存状态并暴露冲突，不静默覆盖 |
| 布局读取或保存失败 | 显式保留错误，不改读 localStorage 或伪造已保存结果 |
| 离开后快速重进，旧页面 PUT 晚于新页面 GET 完成 | 每次挂载重新 GET，并按 revision 单调接受更晚完成的保存结果 |
| 409 重载期间业务节点集合变化 | 丢弃点击前的布局提交，用响应时最新节点集合 reconciliation 并保存 |
| store 有本地提交时 Query cache 出现更高 revision | 仍以 store 实际 hydrate 的 revision 发起 CAS，让服务端返回 409；不得借缓存 revision 静默覆盖 |
| 409 重载请求期间再次拖拽 | 保留新坐标和冲突状态，不用远端响应覆盖，也不发送无意义的重复快照 |
| 用户拖动后撞到另一个 `manual` 节点 | 返回 `{ accepted: false }`，调用方回滚到 drag start 坐标 |
| 用户拖动后只影响 `auto` 节点 | 返回 `{ accepted: true }`，拖动节点保持 manual 坐标，其它 auto 节点用局部物理碰撞微调 |
| `auto` 节点互相重叠 | 行序碰撞布局跳过冲突 slot，继续从左到右、从上到下寻找下一个可用位置 |
| 自动同步时已有 manual 节点占据默认 slot | 该节点保持 manual 坐标，新增 auto 节点跳过被占用 slot |
| 刷新只更新已有 artifact 内容或 generated-video 状态 | 既有节点坐标不变，只更新节点 data；不得按刷新时视窗重排 |
| 普通 session assets 快照变化但没有 generated-video artifact | 只更新 `projectMedia`，画布节点列表和坐标不变 |

### 5. Tests Required

- 布局器单测必须覆盖前 2 个起点、第三列 `bounds.maxX` 限制、输入顺序、manual 固定、auto 跳过 manual 占用 slot、拖拽后的局部物理微调和全量无矩形重叠。
- API helper 单测必须覆盖 GET/PUT 路径、严格 `{ layout }` envelope、`schemaVersion: 1`、`expectedRevision`、完整节点快照和非法响应拒绝。
- store 单测必须覆盖服务器快照 hydrate、项目节点与 Direct workspace 节点共用同一位置快照、拖动成功变 manual、manual/manual 拒绝、syncArtifacts/syncProjectMedia/尺寸变化后 manual 坐标不变，以及不再读写 localStorage。
- coordinator 测试必须覆盖先 hydrate 后保存、drag-stop 只触发一次完整快照 PUT、最新 revision 接续保存、失败不 fallback、409 不被当作成功、store 基线 revision 与 Query cache revision 分离、409 重载期间业务节点或拖拽变化，以及离开后快速重进时旧 PUT 与新 GET 的先后竞态。
- viewport 行为必须覆盖拖拽失败回滚、拖拽成功经 `onNodeDragStop` 提交、页面重载后服务器坐标恢复，以及 zoom/fit view 不触发布局漂移。

## Project 元数据

### Scope / Trigger

修改项目页标题、项目元数据读取或后端自动命名收敛时读取本节。

### Contracts

- `getProducerProject(projectId, { signal }?)` 调用 `GET /api/projects/{projectId}` 返回项目摘要；`deleteProducerProject(projectId)` 调用 `DELETE /api/projects/{projectId}`，成功时不解析响应体。
- `id`、`title`、`kind` 只来自后端项目接口；不得从 AG-UI state 推导。
- `createdAt` / `updatedAt` 后端缺失时保留 `null`，不伪造时间。
- 项目页进入历史项目时先读取 project 元数据；AG-UI restore 只恢复 messages、HITL 和 Producer 业务状态。
- 后端自动命名是 background 行为；`RUN_FINISHED` 后刷新 project 元数据，默认标题仍为 `新对话` 时允许短轮询。
- `RUN_FINISHED` 后的业务状态收敛和项目标题短轮询必须共用可中止控制；任一分支失败时，不得在另一分支停止前清空 abort controller。

### Validation / Tests

| 条件 | 正确处理 |
| --- | --- |
| project 接口非 2xx | 按 project API 错误格式抛错 |
| project 响应缺 `id` / `title` / `kind` | mapper 抛明确字段缺失错误 |
| `createdAt` / `updatedAt` 缺失 | 保留 `null` |
| `RUN_FINISHED` 后标题仍为 `新对话` | 按固定短轮询计划重新读取 project 元数据 |
| 项目切换、卸载或新 run | 中止剩余 project 元数据轮询 |

必须测试端点、字段映射、缺失时间、错误处理、初始化标题读取、run 后标题刷新、短轮询和 abort。

## Common Mistakes

- 不把 AG-UI `Message.id` 当作前端展示轮次 id。
- 不生成 `turn-N`，不用最新消息、本地 running 状态、media key 或 analysis 顺序推导 artifact / HITL 轮次。
- 不为了恢复当前轮插入“id 等于 turnId”的本地消息。
- 不从旧 `_iclip.activeRequirements` 恢复 HITL 状态。
- 不从 AG-UI state 读取项目标题或业务 artifact 索引。
- 不在前端 JavaScript 里持有 token、恢复 BFF 或 `producer_access_token`（见 [ADR-0001](./adr/0001-vite-spa-same-origin-no-bff.md)）。
