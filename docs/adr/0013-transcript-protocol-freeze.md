# ADR-0013: transcript 协议冻结——kimi 字段全部保留，只填能填的

- 状态：已接受（2026-09-05）
- 补充 **[ADR-0005](0005-transcript-protocol.md)** 取舍「协议字段名逐字照抄」：照抄的范围定为全部字段，并给出每个可选字段的填充口径。
- **[ADR-0007](0007-tool-declaration-surface.md)** 决策 6（工具帧 `metadata`）与 **[ADR-0012](0012-subagent-transcript.md)**（子代理流）不变。

## 背景

transcript 的实体与操作逐字照抄 kimi 协议 0.0.2 的 zod schema，前端的 reducer 也是照抄来的。照抄进来的服务端模型带着一批为 kimi 引擎功能而设的可选字段，其中一部分从未赋值；两处有意偏差（轮头与用户块带 `content`、工具帧带 `metadata`）已经落地。协议一发出去就有浏览器、金样和落库数据依赖它，字段改名、改类型、删除都是破坏性变更。

kimi 网页端认领气泡的做法：轮头的 `triggerPromptId` 对应发出去的消息，插话块的 `promptIds` 对应插队的消息，认不到再退回归一化文字比对。我们的浏览器此前按锚点位置加内容逐字相等认领，依赖的是一条没写下来的契约。

## 决策

### 1. 已镜像的字段一个不删；新字段只能是可选项

已有字段不改名、不改类型、不删。新增字段必须可选，且服务端模型、前端 vendored schema、实时投影、历史重建、金样五处在同一个 PR 落齐。前端 schema 对未声明的字段是剥掉而不是报错，漏掉 schema 那一处不会红，所以金样测试要对新字段做存在性断言。

kimi 有而服务端未声明的部分（步的 `timing` / `retry`、工具帧的 `inputText` / `progress` / `taskId` / `todoId`、`origin.payload`、`marker.upsert` / `taskref.upsert` / `attachment.upsert` / `todo.upsert`、`meta.goal` / `modes`、agent 状态里的 `model` / `thinkingEffort` / `usage` / `permission` / `phase`）不新增；前端 schema 已有它们，要加时按本条走。

### 2. 两处有意偏差维持

轮头与用户块带 `content`（提交体的原样 parts），不用 kimi 的 `prompt` + `attachmentIds` + attachment 实体；工具帧多一个 `metadata`。前者是 pydantic-ai 消息的原样投影，保留图文顺序；后者是纯增量。

轮头 `content` 与提交体的 parts 逐字相同，是契约：历史重建给插话块配 `promptIds` 靠它（见字段表）。

### 3. 字段表

| 字段 | 处理 | 来源或原因 |
|---|---|---|
| `TurnHeader.triggerPromptId` | 填 | 实时取运行器手里的消息行；历史取 run → prompt 映射（`agent_job_runs`）。重新生成铸新 id，值随之变 |
| `TextFrame.promptIds` | 填，只在插话块 | 轮里没有触发消息的块，首条用户消息是轮头 `content`。实时按 `enqueue_id` → prompt 映射；历史在同一轮的 run 集合里取插话行（`steered_at` 非空），按 `steered_at` 序取第一条内容相等且未消费的，对不上留空 |
| `TurnHeader.durationMs` | 填，仅终态 | 结束时间减开始时间；running 与等审批不填 |
| `AgentDescriptor.disposedAt` | 填 | 子代理任务的 `endedAt` |
| `TranscriptTask.model` / `thinkingEffort` | 填 | 子代理落库 `metadata` 的那份字典，实时与历史读同一份；`model` 是供应方模型 id |
| `TranscriptTask.stateReason` / `outputTail` | 点名保留，暂不填 | 留给子代理挂起原因与后台任务输出；`outputTail` 在协议里是必填字符串，发空串 |
| `Prompt.userMessageId` | 留空 | 只有一张消息表 `agent_jobs`，其 id 就是 `promptId`；kimi 的第二个 id 来自独立的消息表 |
| `StepHeader.endReason` / `endMessage` | 留空 | pydantic-ai 只给 `finish_reason` |

### 4. 认领按 id

浏览器按轮头 `triggerPromptId` 认发出去的消息，按插话块 `promptIds` 认插队的消息，认不到退回归一化文字比对，与 kimi 网页端同一实现。锚点逻辑删除。

## 取舍

- **不加消息表。** `userMessageId` 唯一能填的值要么是 `promptId`（重复），要么是轮里的块 id（提交时轮号未定）。快照已经是消息历史的存储，第二张表意味着两份事实要同步。
- **不做步的 `retry`。** pydantic-ai 不发模型请求重试事件；网络层重试在 SDK 内部静默完成。填不出来的字段不声明。
- **接受历史重建给插话块配 id 靠内容相等。** `enqueue_id` 只在事件上，不进消息历史；同轮内按顺序配对是服务端内部的事，浏览器只看 id。
- **接受子代理页面暂无自己的 `prompts`。** 子代理一次派发一轮，任务文本在轮头 `content`。
