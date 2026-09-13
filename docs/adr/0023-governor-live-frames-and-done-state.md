# ADR-0023：治理者收全平台的实时帧，「已完成」按 `last_run_id` 算

- 状态：已接受（2026-09-12）
- 修订 **[ADR-0008](0008-activity-from-agent-jobs.md)** 决策 2 的派发范围、决策 3 的 `done` 口径，以及取舍里「筛选的 id 集在应用层算好再传 IN 列表」那句的算法。
- 前提：**[ADR-0002](0002-unified-permission-model.md)** 的 `users:manage` 是治理者读全平台的权限；**[ADR-0013](0013-transcript-protocol-freeze.md)** 决定新字段只能可选，REST 信封字段以 `title` 为先例。
- 合同 [§5 全局帧与文件订阅](../../contract/conventions.md#全局帧)、[§6 治理者复盘](../../contract/conventions.md#治理者复盘)随本文改口径。

## 背景

治理者要在「全部对话」页看全平台每段对话的状态，含跑完的，并点进任意一段只读地看过程。REST 一侧早就允许治理者跨属主读（transcript 分页、工作区、审计列表），推送一侧却不然：标题、活动、生成任务三帧按属主派发，治理者收不到；`event.fs.changed` 的 `watch_fs_add` 受理了治理者的订阅，投递时却按属主过滤，永远发不出去。

「已完成」原先由 `JobQueue.conversation_ids(owner, state)` 从票据表算：取每段对话的决定行，`busy` 为假的算 done。全平台几百段对话要先扫票据表，再传一个几百个 id 的 `IN` 列表。而对话表自己的 `last_run_id` 本来就是「跑过」的直接证据——它自 #115 起没写过，#309 修回并回填。

## 决策

### 1. 全局帧与文件变更帧发给属主和治理者

连接归谁由握手主体定：属主自己的连接收，持 `users:manage` 的连接也收，别人的不收。四种帧同一条判定（`_Connection.receives`），`watch_fs_add` 的受理范围与投递范围因此一致。权限在握手时快照，吊销后要重连才生效；派发仍是单进程、易失，与 ADR-0008 一致。

### 2. 「已完成」= 跑过且此刻没在跑

只查一个小集合：此刻占着的对话（`agent_jobs.status IN ('running', 'awaiting')`，按属主或全平台，走占用部分索引）。`running` 是这个集合；`done` 是 `last_run_id IS NOT NULL AND id NOT IN busy`；`all` 不筛。侧栏与审计同一条规则；审计接口收 `state`，并给两个真总数 `total` / `runningTotal`。

口径变化一处：run 还没挂上租约就结束的行（`run_id` 为空）以前算 done，现在只在 `all` 里——它从没在对话上留下过 run。

### 3. 会话页信封带属主

`GET /transcript` 顶层加可选 `owner_user_id`，与 `title` 同做法：由 REST 端点填，引擎不认识对话表。场景金样由引擎侧直接生成，没有这一项；存在性由 HTTP 集成测试断言，前端 schema 按可选解析。

## 取舍

- **治理者不能按对话选择性收全局帧。** 帧不看订阅，治理者一律全收；内部规模下一次 run 开始一帧，可接受。
- **不做跨进程派发。** 与 ADR-0006 / ADR-0008 一致，列表接口是事实源。
- **`done` 不再等价于「算得出 last_turn_reason」。** 换成对话表自己的列；conversations 域只收一个 busy 集，仍不跨 schema 查票据表。
