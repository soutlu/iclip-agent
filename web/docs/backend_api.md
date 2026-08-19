# Producer 后端接口契约

> Producer 是纯 SPA，浏览器经同源 `/api/*` 访问后端：dev 由 vite proxy、prod 由反代把 `^/api` rewrite 掉（`/api/users/me` → 后端 `/users/me`）。**没有 BFF**（决策见 [adr/0001](./adr/0001-vite-spa-same-origin-no-bff.md)）；认证靠后端种的 HttpOnly `iclip_session` cookie 自动携带，前端不注入 `Authorization` 头。
> 本文记录 UI 参考稿实际消费的接口形状；不代表本仓 `server/` 已实现这些端点，也不约束后端合同。字段级前端事实源是各 API 模块的 zod schema 与调用代码；新后端跨端约定见根仓 [contract/conventions.md](../../contract/conventions.md)，前端对接范围与时点由用户决策。

当前前端事实源一览：

| 领域 | 端点 | 代码位置 |
| --- | --- | --- |
| 登录态 | `/api/auth/login`、`/api/users/me`、`/api/auth/logout`、`/api/auth/sso/*` | `src/shared/auth/producer-auth.api.ts` |
| 项目文件夹 | `/api/projects*` | `src/features/projects/api/producer-project.api.ts` |
| Video Task 与 Session 关系 | `/api/video-task-sessions*` | `src/features/video-task-sessions/` |
| Session Workspace / assets / generations | `/api/sessions/{sessionId}*` | `src/features/projects/api/producer-session-workspace.api.ts` + `src/features/chat/runtime/project-agui-runtime.ts` |
| AG-UI 运行 | `/api/agui/teams/producer*`、`/api/agui/agents/storyboard*`；run 历史走 `/api/sessions/{sessionId}/runs` | `src/features/chat/runtime/`、`src/features/storyboards/runtime/` |
| 视频生成 | `/api/video-generations` | `src/features/projects/api/producer-project.api.ts` |
| 上传预签名 | `/api/presign` | `src/shared/lib/file-upload.ts` |
| 用量分析 | `/api/analytics/generation-stats` | `src/features/analytics/` |

## 1. 登录态

会话是服务端状态：后端 fastapi-users 种 HttpOnly `iclip_session` cookie，前端 JavaScript 不持有 token。登录态经 react-query-auth 进 TanStack Query 缓存（`src/shared/auth/session.ts`）。

### 登录

```http
POST /api/auth/login
Content-Type: application/x-www-form-urlencoded

username=luke&password=secret
```

成功返回 204 并 `Set-Cookie: iclip_session=<jwt>; HttpOnly; ...`。响应体不含 token。

### 当前用户

```http
GET /api/users/me
```

返回 `{ "user": { ...camelCase 字段，含 role / permissions } }` 包装，是登录态唯一事实源。SSO 用户还包含 `city`、`jobTitle` 与完整 `departments[]`；部门字段为 `id`、`uid`、`name`、`parentId`、`parentUid`、`leaderUserId`、`leaderUserUid`、`source`、`type`、`order`。密码用户或尚未重新登录同步的存量用户返回空城市、空职位和空部门数组。401 表示未登录。页面/功能门控判 `user.permissions` 里的后端权限字符串（如 `analytics:read`），不使用前端用户名白名单。

### 退出

```http
POST /api/auth/logout
```

后端注销会话并清 cookie；返回 401（会话本就失效）视为登出成功。

### SSO

- `GET /api/auth/sso/authorize` → `{ "authorization_url": "..." }`。后端 SSO 关闭时不挂 `/auth/sso/*` 路由（404），前端据此探测可用性。
- SSO 服务回跳前端路由 `/auth/sso/landing?jwt_token=...`；落地页调 `GET /api/auth/sso/callback?jwt=<jwt_token>` 换会话 cookie。

## 2. 私有项目

项目 id 由后端生成。前端路由 `/projects/{id}` 中的 `{id}` 就是后端 `projectId`。

### 项目列表

```http
GET /api/projects
```

响应 `{ "projects": [ { "id", "title", "kind", "sessionIds", "createdAt", "updatedAt" } ] }`。Project 只记录它包含的 Session，不记录 Video Task；`createdAt` / `updatedAt` 允许后端暂不返回，前端保留为 `null`，不伪造时间。

### 创建项目

```http
POST /api/projects
Content-Type: application/json

{ "kind": "agent", "title": "新项目" }
```

Producer Agent 与 Storyboard 项目提交 `{ kind: "agent" }`，普通画布项目提交 `{ kind: "direct" }`。Project 创建请求不携带 target 或 Video Task id；Storyboard 的 Task-Session 关系通过独立接口创建。

### 项目详情 / 删除

```http
GET    /api/projects/{projectId}
DELETE /api/projects/{projectId}
```

项目页标题只来自详情接口的 `project.title`；AG-UI state 不承载项目标题。删除成功（2xx/204）后前端从最近项目列表移除。

### 项目 session 列表

```http
GET  /api/projects/{projectId}/sessions
POST /api/projects/{projectId}/sessions
```

GET 是项目页初始化 session tabs 的事实源；每条 session 摘要都包含不可变的 `target`，前端只消费当前工作台 target 对应的 sessions，再选择 active session 并派生后台订阅集合。不得使用项目详情里的 `sessionIds` 聚合字段替代。

POST 每次创建一个普通多会话 session，运行目标在此处绑定而不是绑定到 Project：

```json
{ "target": "producer" }
```

POST 响应 `{ "session": { "id", "projectId", "target", "title", "createdAt", "updatedAt" } }`。target id 的合法性由后端运行目标注册表校验；同一 Project 可以创建多条 Session。Storyboard 不使用专属或单例 Session 接口。

### VideoTaskSession

```http
POST /api/video-task-sessions
Content-Type: application/json

{ "projectId": "project-1", "videoTaskId": "task-1", "target": "storyboard" }
```

POST 为 Video Task 创建一个新的 Project Session 和显式关系，响应：

```json
{
  "videoTaskSession": {
    "videoTaskId": "task-1",
    "createdAt": "2026-08-02T12:00:00Z",
    "session": {
      "id": "session-1",
      "projectId": "project-1",
      "target": "storyboard",
      "title": "新对话",
      "createdAt": "2026-08-02T12:00:00Z",
      "updatedAt": "2026-08-02T12:00:00Z"
    }
  }
}
```

```http
GET /api/video-task-sessions?projectId={projectId}
```

GET 响应 `{ "videoTaskSessions": [...] }`。前端用 `videoTaskId` 与 Task 精确连接，用 `session.id` 作为该 Storyboard 的 AG-UI `threadId`；不得按 Project 的 Session 顺序、target 或时间推断关系。同一 Video Task 可创建多条关系，每条关系都有独立 Session。

### 项目画布布局

`project_canvas_layouts` 是项目级画布位置的后端事实源。Producer 本阶段只在 Direct Canvas 消费该契约；Agent workspace 仍以 session 为运行与渲染单位，未接入项目布局远端 coordinator。读取和替换都使用 `{ "layout": ... }` envelope：

```http
GET /api/projects/{projectId}/canvas-layout
```

```json
{
  "layout": {
    "schemaVersion": 1,
    "revision": 7,
    "nodes": [
      {
        "nodeId": "storyboard-workbench:root",
        "x": 420,
        "y": 280,
        "layoutMode": "manual"
      }
    ],
    "updatedAt": "2026-07-21T10:30:00Z"
  }
}
```

从未保存过布局的项目返回 `schemaVersion: 1`、`revision: 0`、`nodes: []`、`updatedAt: null`，不用 404 表示空布局。

```http
PUT /api/projects/{projectId}/canvas-layout
Content-Type: application/json
```

```json
{
  "schemaVersion": 1,
  "expectedRevision": 7,
  "nodes": [
    {
      "nodeId": "storyboard-workbench:root",
      "x": 520,
      "y": 310,
      "layoutMode": "manual"
    }
  ]
}
```

PUT 是完整快照替换，不是单节点 patch。成功响应仍为 `{ "layout": ... }`，其 `revision` 比 `expectedRevision` 大 1；当前服务器 revision 与 `expectedRevision` 不匹配时返回 `409 Conflict`，调用方不得静默覆盖。`schemaVersion` 目前只接受 `1`；`layoutMode` 只接受 `auto | manual`；`nodeId` 在同一快照内唯一，必须是不随数组下标、节点总数或排序变化的稳定业务标识。

快照只包含项目节点的 `nodeId`、`x`、`y` 和 `layoutMode`；不保存 React Flow 组件数据、选中/高亮状态、节点内容或 viewport。所有读写都经项目归属校验，不可见项目按现有规则返回 404。

另有 `GET /api/projects/{projectId}/assets`、`GET /api/projects/{projectId}/generations` 供项目级媒体与生成记录读取。

## 3. Session Workspace 与业务事实

Session Workspace 是画布持久化产物的唯一事实源；session assets 与 generations 分别是媒体账本和生成任务事实源。这三类数据不从 AG-UI state 或 messages 提取：

```http
GET /api/sessions/{sessionId}/workspace/files
  -> { "files": ["brief.md", "video_shot.json", "image/{assetId}.md"] }

GET /api/sessions/{sessionId}/workspace/file?path={canonicalPath}
  -> { "content": "..." }
  ETag: "7"

PUT /api/sessions/{sessionId}/workspace/file?path={canonicalPath}
If-Match: "7"
Content-Type: application/json

{ "content": "..." }

-> 204 No Content
ETag: "8"

GET /api/sessions/{sessionId}/assets       -> { "assets": [...] }
GET /api/sessions/{sessionId}/generations  -> { "generations": [...] }
```

- `GET /api/sessions/{sessionId}/assets` 列的是 **session 账本**（进入过本会话的素材：消息携带的与生成产出的，含复用既有身份的行），不是「登记地点为本 session」的行；@ 菜单以此为数据源。

- `files[]` 是 Workspace canonical 逻辑路径并由后端排序；前端对可见 Markdown 与根目录 `video_shot.json` 逐文件读取。
- GET 和成功 PUT 都必须返回 opaque `ETag`。前端不解析版本，修改时把读取值原样放入 `If-Match`；缺失 ETag 是契约错误。
- PUT 未带 `If-Match` 返回 428，格式非法返回 400，版本过期返回 412；前端必须暴露冲突，不重试或静默覆盖。
- Workspace artifact identity 为 `workspace:${canonicalPath}`。`image/{assetId}.md` / `video/{assetId}.md` 以 path 中的 AssetId 精确关联 session asset；未知或类型不一致时显式失败。
- Workspace 写入工具成功结果统一为 `{ "message": "...", "path": "..." }`。这只是 list/read 失效通知，不是文件正文或第二事实源。
- session 重命名走官方 AgentOS：`POST /api/sessions/{sessionId}/rename`，body `{ "session_name": "..." }`。

## 4. AG-UI 协议

Producer Agent 项目的 target 由 `VITE_AGUI_TARGET_PATH` 决定（默认 `/agui/teams/producer`）；Storyboard 固定使用已注册的 `/agui/agents/storyboard`。run 端点就是 target path 本身：

```http
POST /api/agui/teams/producer            # 运行（含 HITL resume）
POST /api/agui/teams/producer/restore    # 历史恢复
POST /api/agui/agents/storyboard         # Storyboard 运行
GET  /api/sessions/{sessionId}/runs      # 官方 AgentOS session runs list
```

### 运行

普通 run 使用标准 AG-UI `RunAgentInput`。`threadId` 等于当前 Session id（后端会话 id，不是 Project id 或 Video Task id）；`runId` 是 assistant-ui runtime 生成的 opaque id，不承载后端 run id 或前端展示轮次语义。

```json
{
  "threadId": "session-123",
  "runId": "runtime-run-1",
  "messages": [],
  "tools": [],
  "context": [],
  "state": {},
  "forwardedProps": {}
}
```

前端不得传 `turn_id` / `turnId`、后端 run id、身份字段或 `passMedia`。普通 run 的 `state` 按 AG-UI runtime 默认行为透传。后端固定以 `background=True` 运行；最后一条用户消息中的标准 AG-UI content parts 由服务端转换为媒体引用协议，在保留文本/媒体交错顺序的同时登记进当前用户的素材账本（属主内按 URL 去重复用既有身份，无命中才新登记 Session 行）。客户端不参与媒体处理策略。

### 历史恢复

项目页初始加载或重新挂载 session runtime 时：

```http
POST /api/agui/teams/producer/restore
Content-Type: application/json

{ "threadId": "session-123" }
```

响应 JSON，前端读取：

- `messages`：AG-UI 消息历史（leader 视角，不混入成员消息）；持久化的模型思考以标准 `role: "reasoning"` 消息紧邻对应 assistant 之前返回。前端由 `fromAgUiMessages()` 恢复标准 assistant-ui 消息、附件、reasoning、metadata/status，再后处理 Productor 工具结果归属、内部 confirmation 与孤立 tool result；paused 时当前 assistant message 带 `metadata.custom.agui.interrupts`，缺本轮 assistant 时后端已补 `agui-interrupt:{interruptId}` placeholder；
- `headId`：assistant-ui branchable history 的 canonical head；pending interrupt 时指向承载 metadata 的 assistant message，否则指向最后一条非 tool message；
- `activeRun`：后端唯一恢复决策，`{ "runId": "..." } | null`。非 null 表示 thread 有唯一在途（`PENDING/RUNNING`）顶层 run，前端注水后自动触发一次普通 `startRun`（服务端归因为 attach）；null 时前端不得自行判定重连。`PAUSED` 不属于 activeRun（HITL 恢复走 interrupts metadata）；
- `state`：官方 AG-UI 通用 state，按 runtime 默认行为透传并水合；Producer 不要求、注入或解析产品私有命名空间，也不把 state 当作画布业务事实源；
- `members[]`：team 成员子 run 历史（agent target 恒为空数组）。每项：

  ```json
  {
    "memberId": "creative-director",
    "memberRunId": "member-run-1",
    "parentRunId": "team-run-1",
    "parentToolCallId": "functions.delegate_task_to_member:0",
    "status": "COMPLETED",
    "messages": []
  }
  ```

  `messages` 只含成员自身产出（assistant / tool 角色，含成员自己的 tool_calls 与结果）；前端按 `parentToolCallId` 把成员活动挂到对应 delegate 工具调用的 subagent-flow 卡片下渲染，UI 展示名一律走 `SUBAGENT_LABELS_BY_MEMBER_ID` 映射，不泄露原始 `member_id`。

画布产物与媒体库不从 messages 或 AG-UI state 提取；分别从 Session Workspace list/read 与 session assets/generations（§3）恢复。

### live 成员事件

后端 team 以 `stream_member_events` 打开运行；成员 agent 的事件在 AG-UI 投影层与 leader 主流隔离，包装为 CUSTOM 事件下发（attach 重放同构）：

```json
{
  "type": "CUSTOM",
  "name": "agui.member_event",
  "value": {
    "memberId": "creative-director",
    "memberRunId": "member-run-1",
    "parentToolCallId": "functions.delegate_task_to_member:0",
    "seq": 0,
    "event": { "type": "TEXT_MESSAGE_START", "messageId": "..." }
  }
}
```

- `value.event` 是结构合法的标准 AG-UI 子事件（`TEXT_MESSAGE_*` / `TOOL_CALL_*` / `REASONING_*`），由成员专属投影账本产出；成员的 `RUN_FINISHED` / `STATE_SNAPSHOT` 不下发；
- `seq` 每成员 run 从 0 递增且重放决定论一致：成员投影按 `seq <= lastSeq` 幂等去重，attach 重放天然收敛；
- `parentToolCallId` 可能在成员早期事件上为 `null`（delegate 关联尚未权威确认），前端以后到的非空值为准；
- restore 构建的成员段是权威版本：同 `memberRunId` 的 live 事件不再覆盖。

### 断线重连（服务端归因，ADR-0005 / iclip_agent ADR-0005）

没有独立重连端点，前端也不做任何重连路由决策。恢复决策由 restore 响应的 `activeRun` 下发（`{ "runId": "..." } | null`，后端唯一权威）：非 null 时前端在注水完成后自动触发一次普通 `startRun`；null 时不得自行判定重连（不查 runs list）。

「这次请求是新 run 还是重连」由后端在唯一 run 端点归因：body 是 assistant-ui 生成的标准 `RunAgentInput`，不含 `backendRunId`、`eventIndex`、`reconnect` 等任何前端恢复字段。响应头 `X-Iclip-Run-Mode: new|attach|replay|snapshot` 标注归因结果（仅可观测性）。归因结果对前端全部是同构的完整合法 AG-UI 流：

- **attach**（在途 run）：`RUN_STARTED` → 从 backend event 0 严格连续投影完整前缀 → 权威 `STATE_SNAPSHOT` → live 尾流 → 唯一终止事件。前端凭 messageId 幂等吸收，无 ready 屏障、无 runtime 换代；
- **replay**（终态 run 仍在缓冲）：全量回放至终止事件——同一条用户消息重发（请求丢失重试）会归因到这里，天然至多一次执行；
- **snapshot**（缓冲缺失/截断）：以 DB 已落库事实合成 `MESSAGES_SNAPSHOT` + `STATE_SNAPSHOT` 收尾，前端零特殊处理。

`RUN_ERROR` 错误码全集（golden fixtures 见 `src/shared/agui/__fixtures__/agui_contract/`）：

- `RUN_IN_PROGRESS`（终态）：携新用户消息撞在途 run 的显式拒绝，消息留在本地可重发——重连期间发送框禁用是第一道防线，本码是服务端兜底，任何路径不静默吞消息；
- `ACTIVE_ELSEWHERE`（可重试）：run 在途但当前 worker 暂不可桥接，指数退避后重发普通 `startRun`；
- `CANCELLED`（中性终态）：run 已被主动停止，前端呈现「已停止」。

真实 transport 中断（网络异常或未收到终止事件的提前 EOF）与 `ACTIVE_ELSEWHERE` 同治：连接状态机进入 `interrupted`，指数退避（1s 起 ×2 + 抖动，上限 5 次后 `degraded` 等待手动重试）后重发普通 `startRun`；离线时等待 `online` 事件。用户主动 abort 保持静默。HITL continuation 断线后同样只靠归因 attach 观察已提交的 backend run，绝不重发 `resume[]`。

取消经 `POST /api/agui/teams/producer/runs/{runId}/cancel`（body `{"threadId": "..."}`）提交，返回 202；run 在服务端检查点收敛为 `CANCELLED` 终态。

### HITL 续跑

没有独立 HITL 端点。HITL continue 使用标准 AG-UI `RunAgentInput.resume[]`，提交到同一个 run 端点：

```json
{
  "threadId": "session-123",
  "runId": "runtime-run-2",
  "messages": [],
  "tools": [],
  "context": [],
  "state": {},
  "forwardedProps": {},
  "resume": [
    {
      "interruptId": "req-ask-1",
      "status": "resolved",
      "payload": { "selections": { "风格": ["高级感"] } }
    }
  ]
}
```

工具审批同样走 `resume[]`（接受为 `{ "approved": true, "note": "..." }`，拒绝为 `{ "approved": false, "note": "..." }`，两者的 resume entry `status` 都是 `resolved`）。前端通过公开 `useAgUiInterrupts()` 读取待处理项，通过 `useAgUiSubmitInterruptResponses()` 提交；来源是 restore message metadata 或 live `RUN_FINISHED.outcome.interrupts[]`。多个 pending interrupts 逐个展示、本地暂存，并按 `@assistant-ui/react-ag-ui` runtime 的公开接口要求，在全部回答后一次性提交覆盖全部 pending interrupts 的 `resume[]`。不得读取 `state._required.activeRequirements`。

`resume[]` 只提交一次到普通 run 端点（`resume` 非空在服务端绕过归因树直接续跑）。continuation SSE 断线不代表提交失败：后台 run 仍由后端持有，前端不得自动重试相同 `resume[]`，重连后由服务端归因 attach 观察该 run 的后续结果。

## 5. 视频生成

统一提交端点（Direct 画布与 Agent Workspace artifact 内提交共用）：

```http
POST /api/video-generations
Content-Type: application/json

{
  "assetType": "video",
  "requestPayload": {
    "inputs": [
      { "kind": "url", "mediaType": "image", "url": "https://cdn.example.com/reference.png" }
    ],
    "model": "...",
    "params": { "aspectRatio": "16:9", "durationSeconds": 5, "shotIndex": 1 },
    "prompt": "当前编辑后的镜头提示词",
    "type": "video"
  },
  "scope": { "type": "project", "projectId": "project-123" }
}
```

- `scope` 二选一：`{ "type": "project", "projectId" }`（Direct 画布）或 `{ "type": "session", "sessionId" }`（Agent Workspace artifact 内提交，`shotIndex` 来自当前视频提示词 batch）。
- `inputs` 由前端把参考图/视频/音频 URL 按 `mediaType` 拆分（`splitVideoGenerationReferenceUrls()`）；本地附件必须先经 presign 上传成远端 URL。
- 提交成功后：Agent scope 合并本次 generation 并刷新 Session Workspace、assets 与 generations，让 generated-video artifact 进入画布并驱动后台轮询；Direct scope 只写 route-local 任务列表并同步 `video-generation-task` 节点。

## 6. 文件上传预签名

```http
POST /api/presign
Content-Type: application/json

{ "ext": "png", "dir": "producer/media/image" }
```

返回上传签名 URL、object key、公网访问 URL 和 content type；前端随后直传 OSS（PUT），拿 `publicUrl` / `contentType` 写入 AG-UI 消息或生成请求。OSS 直传的 403 与会话权限无关，只有 presign 接口本身的 403 才按未授权上报。支持的扩展名与 `dir` 约束以后端配置为准。

**上传即登记**：composer 的本地附件（聊天，以及首页/画布的视频生成入口）在 PUT 成功后、提交前统一调 `POST /api/assets`（`registerUploadedAsset()`，body `{assetType, source: "upload", url, mimeType, sessionId?, sizeBytes?, metadata: {filename}}`）由素材库签发身份——get-or-create 语义，同 URL 幂等命中同一行；只有聊天入口透传 `sessionId` 作为登记地点（provenance），它不构成授权、不写 session 账本（入账由后端在消息真正进入对话时完成）。提交失败时素材已在库中，重试按 URL 命中同一身份。

## 7. 首页 Video Task

```http
GET  /api/video-tasks
GET  /api/video-tasks/{taskId}
GET  /api/video-tasks/product-info?styleNo=SNST26006U
POST /api/video-tasks
POST /api/video-tasks/{taskId}/publish
POST /api/video-tasks/{taskId}/confirm
POST /api/video-tasks/{taskId}/withdraw

{
  "styleNo": "SNST26006U",
  "deadline": "2026-08-05T23:59:59Z",
  "brief": {
    "videoType": "短视频",
    "platform": "Social-TT",
    "ratio": "9:16",
    "color": "BLUE/BLACK、MATTE GREEN",
    "contentType": "穿搭",
    "department": "市场部",
    "requester": "amy.zhang",
    "requirementDescription": "场景：similar to reference with city street\n服装：same as reference\n…",
    "styleNos": ["SNST26006U", "RAIN2026"],
    "referenceImages": [],
    "referenceVideos": ["UPLOADED_VIDEO_ASSET_1"]
  }
}
```

任务页分「下发 Task（需求方）/ 确认 Task（策划师）」两种视角，状态机为 `draft → published（下发）→ confirmed（确认）→ withdrawn`（published 与 confirmed 均可撤回）。下发提交 = `POST /api/video-tasks` 创建 draft 后立即 `POST …/publish`；策划师在确认视角按部门 / 需求人 / 品牌筛选 published 任务并 `POST …/confirm`，published 与 confirmed 任务均可作为 Storyboard 创作来源。参考媒资不再是发布必要条件（Ref Vid 非必填）。

确认视角的展开详情内置确认补充与「创作材料」编辑区：策划师点击需求描述的修改按钮后复用 Tiptap 编辑整段中文标题纯文本，可按需追加 `口播旁白：…`，不建立平行 Brief 字段。比例从 `9:16`、`16:9`、`3:4`、`1:1` 等规范选项中选择；时长可直接调整，有参考视频时默认读取最终清单中首个视频的媒体元数据并四舍五入为整数秒，用户可覆盖，最终值仍遵守 `3–50` 秒约束。策划师还可从已选 Style 的产品图中多选参考图、上传补充图片（两者统称参考图），也可在「爆款视频」弹层选择库内推荐或主动联网搜索，并保留视频上传入口。推荐池只在打开弹层后查询；选中完成后，视频退出推荐语义，和已有视频、上传视频统一排列在参考视频列表。保存时新上传文件走 presign + `POST /api/assets`（`source=upload`）；选中的产品图按 Style 分组调用 `POST /api/video-tasks/product-images/import`（`{styleNo, imageIds}`，只处理选中的少量图片）；选中的库内爆款视频调用 `POST /api/inspirations/videos/import`（`{videoIds}`）完成转存和 Asset 登记。联网搜索只返回可用官方播放器预览的候选，不下载视频；前端在外层「保存创作材料」时才把选中候选的 opaque `selectionToken` 交给 `POST /api/inspirations/videos/web-import`，并把返回的 `assetId` 写入待保存的 `referenceVideos`。确认结果与最终素材清单通过 `PUT /api/video-tasks/{taskId}` 整单保存。后端在 `POST /video-tasks` 与该 PUT 的写入边界把每个参考视频转成 H.264 MP4 派生 Asset，并在响应 Task 中返回派生 Asset id；转码失败则本次 Task 不写入，Agent 不参与转码。后端在 published/confirmed 状态只允许 `requirementDescription`、`durationSeconds`、`ratio`、`referenceImages`、`referenceVideos`（连同管理信息）变化，其余 Brief 字段必须原样回传；素材更新时重新校验 Asset 存在、未归档且类型匹配。

```
POST /api/inspirations/videos/search
{ "styleNos": ["SNST26006U"], "sortBy": "orders", "limit": 50 }

POST /api/inspirations/videos/import
{ "videoIds": ["7642976776691469598"] }

POST /api/inspirations/videos/web-search
{
  "taskId": "task-1",
  "category": "tactical boots",
  "scene": "creek",
  "sellingPoint": "quick-drying",
  "platform": "tiktok"
}

POST /api/inspirations/videos/web-enrich
{
  "taskId": "task-1",
  "platform": "tiktok",
  "selectionTokens": ["opaque-selection-token"]
}

POST /api/inspirations/videos/web-import
{ "taskId": "task-1", "selectionTokens": ["opaque-selection-token"] }
```

爆款库推荐接口：`styleNos` 为任务关联 Style 全集（≤20），`sortBy ∈ impressions | views | clicks | orders | revenueAmount`（默认 `orders`，服务端排序决定 top-N 取样），另支持可选 `filters.min*` 表现下限。前端只在打开「爆款视频」弹层后按默认排序拉一次推荐池（`limit=50`）：返回条数小于 limit 说明候选池完整，切换排序本地重排、不再请求；只有池被截断（= limit）时换排序才回服务端重新取样（top 集合随排序维度变化），且保留上一份列表避免闪空加载态。响应 `{ items, count, matches }`：`items[]` 含 `videoId`、`styleNo`、`ossUrl`（仅作为目录源地址）、`videoUrl`/`creatorHandle`/`postedDate`（可为 null）与 `metrics {impressions, views, clicks, orders, revenueAmount}`；`matches[]` 标注每个输入 Style 的匹配层级（`exact | sameBrandCategory | sameCategory | none`，无同款时服务端按品牌/品类逐级回退推荐替代款视频）。import 接口按 `videoId` 在服务端重新解析可信源地址，只处理被选中的视频；object key 由源 URL 的 SHA-256 稳定派生，OSS 已存在时跳过下载与上传，再登记为当前用户的不可变 import Asset，返回 `{assets: [{videoId, assetId, url}]}`。

联网搜索是弹层中的用户主动操作，不受库内是否已有同款或替代款结果限制。品类、使用场景和可选卖点都是本次搜索的瞬态事实：前端可以从受控中英词对预置，并同时展示中文含义与可编辑英文检索词，但不得调用任意机器翻译、从自由文本 Brief 猜测或把这些字段写回 Task。当前受控词对包含 `军事用靴 / tactical boots`、`溪流 / creek`、`速干 / quick-drying`；请求只提交英文值。服务端用非空字段按 `category + scene + sellingPoint` 构建一个 query；web-search 的必填 `platform ∈ tiktok | instagram | youtube` 表示一次请求只搜索一个平台，响应 `{source: "web", query, platform, items}`。用户一次点击会用完全相同的英文事实同时发起三个普通 POST；三个请求独立完成、独立报错，先完成的平台立即展示，不等待其它平台。每个平台最多取上游返回顺序中的 10 条，不做内容理解、指标过滤、平台内重排或跨平台合并排名。TikTok 与 Instagram Reels 均由 Bright Data Discover `fast` 按 AI 相关性排序，内部 query 分别追加 `site:tiktok.com`、`site:instagram.com/reel/`；服务端只保留标准平台视频 URL，并保留其过滤前 `responsePosition`，所以结果可少于 10 条且排名允许有空位。每项包含 `platformVideoId`、`responsePosition`、`postUrl`、`title`、`creatorHandle`、`durationSeconds`、`thumbnailUrl` 与 opaque `selectionToken`，其中 `title`、`creatorHandle`、`durationSeconds`、`thumbnailUrl` 四个展示字段允许为 null。

每个平台的 web-search 成功后，前端立即显示候选并只把该平台有序的 `selectionTokens` 提交给一次 web-enrich；请求不接受客户端 URL，也不下载或登记 Asset。候选在补全期间明确显示「详情获取中」，响应按原顺序返回 `{source, platform, items: [{selectionToken, platformVideoId, responsePosition, thumbnailUrl, durationSeconds, metrics: {viewCount, likeCount, commentCount, shareCount}}]}`。补全后的 `thumbnailUrl` 必须是合法非空 URL；`durationSeconds` 允许为 null，非 null 时必须为正数。四项指标允许为 null，前端只展示非 null 值；响应缺项、重复、乱序或 token / 视频身份不匹配时整个平台补全失败，不应用部分结果。三个平台的补全状态彼此独立，先完成先原位更新；失败只标记对应平台。新搜索或关闭弹层会取消旧的 search 与 enrich，迟到响应按请求代次丢弃。用户在补全完成前已勾选的候选也会同步替换为补全后的封面、时长和指标，保持选择顺序，且该同步没有 import/save 副作用。

前端固定按 TikTok、Instagram、YouTube 分区，并按每个响应自身的原始数组顺序展示；预览 URL 仅由受控 platform 与 `platformVideoId` 构造，TikTok 使用官方 `player/v1/{id}`、Instagram 使用 `reel/{shortcode}/embed`、YouTube 使用官方 `embed/{id}`，不得把 `postUrl` 当 `<video>` 媒体源。搜索、详情补全、预览、勾选和弹层「完成」均无转存副作用；只有外层保存才调用 web-import，并仅提交用户选中的 token（最多 30 个）。web-import 以 `(platform, platformVideoId)` 幂等下载、上传 OSS 和登记 Asset，201 返回 `{assets: [{selectionToken, platform, platformVideoId, assetId, url, durationSeconds}]}`，其 `assetId` 与其它参考视频 Asset 一起进入 Task `referenceVideos`。

产品信息接口按 `styleNo` 在 PDM/BDE 表中做一次参数化精确等值查询，不创建 Task、零转存副作用；产品图数量可能非常大，`images` 全量返回（服务端已按源地址去重快照重复行，并带 `color` 颜色标签，取值域与 `colors` 的 `name` 一致、可为 null），全部是规范化的 https 源地址（http 源升级 https）、仅供浏览选择，同时返回该 Style 在 ERP 的最新有效颜色列表，成功返回 `{ "product": { "styleNo": "SNST26006U", "brand": "NORTIV8", "category": "运动凉鞋", "images": [{ "id": "PDM_IMAGE_1", "url": "https://SOURCE_URL/...", "color": "BLUE/BLACK" }], "colors": [{ "id": "3", "name": "BLUE/BLACK" }] } }`。转存只发生在两处且都在后端：下发（创建 Task）时首图转存 OSS 冻结为 `style.previewImageUrl` 预览快照；确认阶段选中的产品图经 import 接口转存并登记。`images` 的源地址禁止直接登记为 Asset——进入素材账本的 URL 必须是应用 OSS 公网地址。确认视角的产品图网格按 `color` 提供颜色筛选（多于一种颜色时显示 chips），每张图带「查看大图」预览入口（复用媒体预览弹窗）。`colors` 供表单 Color 多选标签使用：候选 = 已选 Style 产品色的并集，可自定义补充；提交时选中值以 `、` 连接写入 `brief.color`（仍是单个字符串字段）。首页在输入停止 400ms 后自动查询；失焦或按 Enter 时立即提交当前 Style。输入变化会取消陈旧请求，同一个 Style 使用查询缓存，不做逐字联想或模糊搜索。

PDM 图片只用于 Style 查询与产品信息展示：后端先把图片内容按哈希稳定转存到应用 OSS；创建时把 `{ styleNo, brand, category, previewImageUrl }` 保存为独立 `style` 产品快照，其中 `previewImageUrl` 固定取第一张产品图转存后的 OSS 公网 URL；全量产品图列表供确认视角的参考图多选使用。该 URL 只用于列表和任务选择器预览，不进入 `brief.referenceImages` 或 Asset 账本；`style` 快照创建后不可改写。

创建流程固定为：

1. 用户选择的所有参考图片、参考视频先经 `/api/presign` 上传，再分别用 `POST /api/assets` 登记为 `source=upload` 的全局 Asset；不选择参考素材时跳过此步。
2. 前端只调用一次 `POST /api/video-tasks`，提交唯一必填的 `styleNo`、可选截止时间和当前完整 Brief；图片、视频 Asset id 分别放入 `brief.referenceImages`、`brief.referenceVideos`，两组都允许为空。
3. 后端只用 `styleNo` 查询 PDM，把产品图转存 OSS，并在插入前统一校验全部引用属于当前用户、未归档、`source=upload` 且类型匹配；参考视频在同一写入边界转成 H.264 MP4 派生 Asset，Task 保存并返回派生 id。全部步骤成功后一次写入完整 draft，不创建等待 `PUT` 补写的中间记录。

`brief` 的规范顺序是 `theme`、`purpose`、`audience`、`selling`、`scene`、`department`、`videoType`、`durationSeconds`、`ratio`、`language`、`platform`、`color`、`contentType`、`requester`、`requirementDescription`、`styleNos`、`referenceImages`、`referenceVideos`。`department` 在表单中只读展示当前登录用户 PMS 部门数组中的全部有效名称，按返回顺序去重并以 `、` 连接；创建时后端从可信当前用户重新派生并覆盖客户端同名输入，作为 Task 部门快照，未同步部门时不写该字段。`styleNos` 是多选 Style 号全集（主 Style 排首位并同时作为顶层 `styleNo` 生成产品快照）；`requester` 由前端自动取当前登录用户（`displayName`，无则回退 `username`）写入，表单只读展示、不可手填；`requirementDescription` 是按段落换行的纯文本，前端 Tiptap 以 `getText()` 读取内容。下发模板预置场景、服装、道具、灯光、动作姿势、人物族裔、制作备注七项灰字提示：用户完全未填写或清空时把七条提示物化为默认正文；一旦有用户内容就原样提交，不自动补齐其它空行。确认人可以修改整段文本并按需追加口播旁白。所有用户图片不再区分产品、模特或场景，统一进入 `referenceImages`；视频统一进入 `referenceVideos`。`character`、`reference`、`models`、`scenes`、`refVideos` 与 `style.productImages` 已从 Task 契约移除。列表页用 `GET /api/assets?assetId=...` 只解析 Brief 中的 Asset id；Storyboard 读取同一组 Brief 引用作为创作输入，产品首图转存后的 OSS URL 仍只做任务封面预览。
