# ADR-0008: 对话「在忙什么」只从 `agent_jobs` 表算

- 状态：已接受（2026-09-02）
- 取代 `harness/transcript/activity.py` 原先的进程内聚合（PR #135），并修订 **[ADR-0006](0006-durable-runs.md)** 决策 1 的 fence 条件。
- **[ADR-0001](0001-architecture-foundations.md)**：Postgres 是唯一事实源，是本文的前提。
- **[ADR-0006](0006-durable-runs.md)** 决策 4：等审批记在票据行上（`awaiting`），是本文成立的条件。

## 背景

侧栏角标原先有两份来源：推送帧来自进程内存里的聚合（实时那一轮是否 `running`、有没有待回应的交互），列表行来自内存那份与 `prompts` 表合成。#135 选内存聚合的理由是「`prompts` 表答不出卡在等人点头」；ADR-0006 决策 4 之后 `awaiting` 记在行上，这个理由不再成立。会话页那一侧的 `meta.activity` 早已按 `queue.view().active` 置，也就是已经按票据表的口径在算。

kimi 网页版（`apps/kimi-code/dist-web` 构建产物）的形状：会话列表行带 `busy` / `main_turn_active` / `pending_interaction` / `last_turn_reason`；一帧全局广播 `event.session.work_changed` 带同一组字段，`session_id` 在信封上；客户端收到帧就地改本地会话表里那一行，列表刷新时整行覆盖；侧栏角标是行字段的纯函数，优先级写死：等审批 > 等回答 > 运行中 > 失败 > 空闲。kimi 服务端在内存里折 agent 事件得出这几个字段，因为它的会话活在进程里；我们的票据在 Postgres。

## 决策

### 1. 活儿是 `agent_jobs` 表一行状态的投影

| 行状态 | busy | pending_interaction | last_turn_reason |
|---|---|---|---|
| `running` / `steered` | true | none | — |
| `awaiting` | true | approval | — |
| `completed` / `failed` / `aborted` | false | none | 同状态 |
| 没有行 | false | none | null |

每段对话取一行：占着的（`running` / `awaiting`）优先，否则 `finished_at` 最新的终态行。排除 `queued`、`steered`，以及 `run_id` 为空的 `aborted`（从没跑过就撤回的排队消息，不算这段对话的结局）。列表行与帧共用 `JobQueue.activities`。`question` 留在枚举里，没有产地。

### 2. 帧照 kimi：`event.session.work_changed`

`session_id` 在信封，payload `{busy, pending_interaction, last_turn_reason}`。在 `JobQueue` 改到占着那条行状态的写入之后发：以 `running` 落库、队首顶上、进 `awaiting`、审批点齐回 `running`、`finish`、撤回等审批的、清扫判失败。`queued` / `steered` 之间的迁移不发。不看订阅、按属主派发、易失；重连后客户端重拉列表对齐。

### 3. 列表行与筛选

`ConversationOut.activity` 加 `lastTurnReason`。`GET /conversations`、`/ungrouped`、`/by-collection/{id}` 加 `state=all|running|done`：`running` 是有占着的行，`done` 是没有占着的行且算得出 `last_turn_reason`；从没跑过的只在 `all` 里。id 集由 `JobQueue.conversation_ids(owner, state)` 按属主算出，conversations 域只收一个 id 集，不认识票据表。

### 4. 客户端：查询缓存就是会话表

帧到了就地改 TanStack Query 缓存里那一行（拓扑、展开页、搜索三处），行只读自己身上的 `title` 与 `activity`；角标是 `activity` 的纯函数，照 kimi 的优先级；筛选片改 `state` 重拉列表。

### 5. fence 加 `attempt`

`finish` / `attach_run` / `await_approvals` / `release` 比 `(locked_by, attempt)`（照 agno `agno_jobs` 的做法）：进程失租、行被别人接管又被认领回同一进程时，老 task 的晚到写入被代数挡掉。心跳照旧只比 `locked_by`。

## 取舍

- **接受一条跑完接着起下一条时帧先 idle 再 busy。** 不在 `finish` 里跳过 idle：关停途中不接队首，那时行真的空闲，不发帧侧栏就一直转到下次重拉。
- **接受帧只到同一进程上的连接。** `LiveConnections` 每进程一份，与 ADR-0006「不做跨进程实时状态」一致；列表行是事实源。
- **不带 `main_turn_active`。** 没有后台任务与子 agent，它恒等于 `busy`。
- **帧名对齐 kimi，信封不带 `seq` / `epoch`。** 全局帧不进日志，补不了也不必补。
- **`session.meta.updated` 不改名。** 改名那一帧与本文无关。
- **筛选的 id 集在应用层算好再传 `IN` 列表。** 一个人的对话数有限；conversations 域不跨 schema 查票据表。
