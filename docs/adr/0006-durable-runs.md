# ADR-0006: agent 运行跨进程中断续跑

- 状态：已接受（2026-09-01）
- 取代 **[ADR-0005](0005-transcript-protocol.md)** §4「一次 run 就是一轮」，以及它取舍里的「接受运行活在起它的那个进程里」与「排队中的行不跨重启」。
- **[ADR-0001](0001-architecture-foundations.md)**：Postgres 是唯一事实源，是本文的前提。
- **[ADR-0004](0004-generation-queue-in-postgres.md)**：那一份是外部生成任务的排期；本文是 agent 运行的票据。两边都是「事实在自己的表里，排期机械另算」，但这里的排期机械不用 procrastinate（见取舍）。

## 背景

一次 agent 运行可能跑几分钟，等一次审批可能等几天。原来运行活在起它的那个进程里：

1. 进程重启，在跑的那一轮判失败，排队的消息被撤销，用户重启后看到的是什么都没有。
2. 硬崩（OOM、SIGKILL）之后没人发现，那段对话永远「正在跑」。
3. 审批用 `HandleDeferredToolCalls` 在同一次 run 内等人点头，等待随进程一起消失。
4. 启动时的全表清理在多 worker 下会把别的 worker 手上的行判失败。

官方 pydantic-ai 对「跨进程」的答案是 durable_exec（Temporal / DBOS / Prefect）。它不适合本仓的交互式对话：`run_stream_events` 的事件按 step 缓冲后重放，逐 token 直播断掉；`CancellationToken` 在 durable 边界被拒；step 内 `ctx.enqueue` 被拒，插话对不上录制。Temporal 在此之上还要外部集群。

已有的东西够用：官方 `StepPersistence` 在每个工具周期结束时落一份可续跑快照，出错时落 at-failure 快照，`tool_effects` 记着哪个工具在飞；`message_history` 续跑、`DeferredToolRequests` 结束 + `deferred_tool_results` 续跑、每次续跑一个新 `run_id` 用 `conversation_id` 关联，都是官方文档写明的用法。缺的是票据的租约、多次 run 合成一轮的投影，以及等审批那一刻的历史（官方文档写明由调用方持久化）。

## 决策

### 1. 票据带租约，事实在 `agent_runtime.agent_jobs`

- 一条 prompt 变成 `running` 时写上 `locked_by`（进程启动时铸的 id）与 `heartbeat_at`；运行期间每 `heartbeat_seconds` 刷一次心跳。
- 清扫每 `sweep_seconds` 一次，启动时先跑一次：`heartbeat_at` 落后超过 `lease_seconds` 的 `running` 行判中断；有 `queued` 而没人占着的对话叫醒队首。等审批的行没有心跳，清扫跳过。
- fence 用 `locked_by`：心跳、`attach_run`、`finish` 都只改 `locked_by` 等于自己的行；改到 0 行说明行已被接管，运行自行取消。插话行没有租约，随它递进的那次 run 定结局。
- `attempt` 只在「中断后重新认领」时加一（租约过期被接管、优雅关停释放后被下一条命认领），审批续跑不加。到 `max_attempts` 判 `failed`，中断原因记在行上。三个周期与 `max_attempts` 在 `config.yaml` 的 `agent_runs` 段。
- 优雅关停：在跑的走第一方取消（at-failure 快照因此落库），行释放租约、留在 `running`；排队行原样留着。

### 2. 一轮 = 一条 prompt，可跨多次 run

- `agent_job_runs(prompt_id, run_id)` 记一条 prompt 起过的全部 run。transcript 按 prompt 分组成轮，步号跨 run 接着数；前一次 run 的工具调用与后一次 run 里的返回落在同一轮。
- 轮的状态取该 prompt **最后一次** run 的结束事件；若其末尾有开放的审批调用，按 prompt 状态定：等审批 → `running`，撤销 → `cancelled`，失败 → `failed`。更早的 run 只定各自 step 的状态，中断的 run 最后一步为 `interrupted`。
- 续跑的投影器从最新快照与 prompt 行播种：步号偏移、开着的工具卡、轮头部的原始 prompt 与附件。同进程与重启后走同一段代码。

### 3. 续跑是从最新快照新起一次 run

- 老 `run_id` 出现在最新快照里：新 `run_id`、同 `prompt_id`，**不发新的用户消息**，`deferred_tool_results` 也不传，按官方续跑语义接着跑：历史末尾是完整的请求就原样重发；末尾是标着 `interrupted` 的请求，官方把没有返回的调用补成 `interrupted` 返回；末尾是带调用的响应，官方把那些调用重新执行。起跑前读一次 `list_unresolved_tool_effects` 记日志。transcript 里没有触发语帧；官方补的返回在实时那一侧由投影器开轮时按同一形状写到原卡上。
- 老 `run_id` 不在快照里（崩在第一个周期完成前）：用原 content 重跑，同 `prompt_id`、新 `run_id`。
- `run_id` 不复用：官方要求每次续跑一个新 id，`runs` 表主键也不允许。

### 4. 审批是 run 的结束点，不是 run 内的等待

- 主 agent 的 `output_type` 为 `[str, DeferredToolRequests]`；要审批的工具只挂主 agent，子代理保持 `str`。不再用 `HandleDeferredToolCalls`。
- run 以 `DeferredToolRequests` 结束时，runner 经官方 `StepStore` 协议的 `save_snapshot` 把 `all_messages()` 存成 `interrupted` 快照，prompt 置内部状态 `awaiting`、释放租约，实时状态交接并放手。
- `awaiting` 对外报 `running`（与 `steered` 同一做法，协议的状态联合不变）；`prompts.py` 里每处以 `running` 判「占着」的地方都把 `awaiting` 算进去。
- 审批决定记在 prompt 行上；一条响应里全部审批调用都有决定后，CAS `awaiting → running` 并起续跑 run（`deferred_tool_results` 带决定）。两次点击或两个副本只有一个能起。
- `awaiting` 期间插话回 409，新 prompt 排队，撤销把行标 `aborted`。
- 历史侧判定一条调用是审批的规则：某次 run **干净收尾**（官方记下 `run_completed`）却在末尾那条响应上留着没有结果的调用——只有以 `DeferredToolRequests` 结束才是这个形状；崩在工具执行中途留下的形状一样，但那次 run 没有干净收尾。结局看同一 prompt 后一次 run 首条请求里的返回：`denied` 是拒了，其余是放行；补上的 `failed` / `interrupted` 不算——前者是新消息进来之前把前沿收掉，后者是崩溃续跑时官方自己补的。

## 取舍

- **接受有副作用的工具 at-least-once。** 官方续跑会重新执行前沿的调用、或让模型看到 `interrupted` 返回后再叫一次；去重归工具与它所属的领域。`tool_effects` 里停在 `started` 的记录是 unknown_after_crash 信号；生成域自己的 `submitting` 守卫只保护同一个 job。
- **接受中断后自动续跑一次会花钱。** `max_attempts` 默认 2；配置只有一份，开发时 `--reload` 下每次存文件都是一次优雅关停，若有运行在飞也会续跑一次。配成 1 等于只判失败。这推翻 ADR-0005 与原 `discard_stale` 里「重启后不自己花钱调模型」的判断。
- **接受往官方 `snapshots` 表多写一份。** 官方 `StepPersistence` 在 run 以 `DeferredToolRequests` 结束时不存快照（未闭合的工具调用过不了它的门槛），文档写明由调用方持久化。写进同一张表是为了让官方的 `latest_snapshot(include_interrupted=True)` 原样读回，续跑代码不分叉。用的是协议里公开的方法。
- **接受 transcript 的分组拴回一张表。** 消息里只有 `run_id`，没有轮的概念，多次 run 合成一轮只能靠 `agent_job_runs`。原先「不按表排」的理由作废。
- **不复用 procrastinate。** 它关停时的打断是 task cancel，即 `BaseException`，进不了官方收尾分支，终态发不出去；「一段对话同时只跑一条」只有 prompt 行的部分唯一索引在管，它不认识这条约束。
- **不做多进程下停止、插话的跨进程路由，也不做跨进程实时状态。** 租约与 CAS 已让「谁接管」跨进程安全；其余等真需要多进程再决策。
- **清扫不往官方 `events` 表写 `run_failed`。** 中断原因只记在 prompt 行上；没有结束事件的 run 在 transcript 里本来就显示为失败。
