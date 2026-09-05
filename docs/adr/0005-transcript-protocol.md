# ADR-0005: 对话协议换成 kimi code 的 transcript

- 状态：已接受（2026-08-31）。轮与 run 的关系改由 **[ADR-0006](0006-durable-runs.md)** 定（一轮 = 一条 prompt，可跨多次 run）；工具帧的 `metadata` 字段是本仓对 kimi 帧的扩展，见 **[ADR-0007](0007-tool-declaration-surface.md)** 决策 6
- **[ADR-0001](0001-architecture-foundations.md)**：Postgres 是唯一事实源，是本文的前提。

## 决策

kimi code 的 transcript 协议把三件事收在协议里：结构化的轮 / 步 / 块、增量操作、服务端说了算的卡片形状。

### 1. transcript 是投影，不是第二个事实源

持久事实只有官方 `StepPersistence` 存的那份消息历史。已经跑完的轮子从消息现推，正在跑的那一轮在进程内存里。所以没有「transcript 表」，也就没有它和消息历史漂开的可能——上下文压缩会改写消息，物化过的 transcript 会当场对不上。

代价是两条路必须给出逐字相同的结构，这由一组对齐测试钉住。

### 2. 编号从确定的事实算出来，不按到达次序

步 = 一次 run 里第几次模型响应，块 = 这一步里正文与思考的次序（轮的分组见 [ADR-0006](0006-durable-runs.md) 决策 2）。按「谁先到就给谁下一个号」编的话，一次模型重试就会让两条路永久分叉，而且不报错。

为此顶层 agent 的 `StepPersistence` 不设 `agent_name`：设了官方就自己铸 `{名字}-{短 uuid}`，与消息上的 `run_id` 是两套 id，轮的终态就查不出来。子代理同样不设，名字改放 `StepPersistence.metadata`，见 [ADR-0012](0012-subagent-transcript.md)。

### 3. 传输换成 WebSocket

协议本来就是双向的（订阅、补批、停止、插话、审批都要往回说）。批次号加一个进程内的补批日志就够断线续传，不需要一条带重放窗口的外部流——**批次号重来是安全的**：客户端收到 `transcript.reset` 会把本地水位无条件覆写成帧里的 `seq`。这条是整个设计的支点。

### 4. 停止走官方的 `CancellationToken`

不是 `task.cancel()`——外部取消是 `BaseException`，进不了官方收尾用的 `except Exception`，那一轮的终态操作一条都发不出去。

## 取舍

- **接受「协议字段名不按仓内 camelCase」。** transcript 面逐字照抄协议（信封 snake_case、实体 camelCase），因为客户端的 reducer 是照抄来的 zod schema。一半照抄一半翻译，写客户端的人得记两套。
- **接受一张 prompt 表。** 「一段对话同时只跑一条」这条挡板必须跨 worker——每个 worker 一份进程内存，谁也看不见谁在跑，没有库上的约束就会两个 worker 各起一次 run 往同一段消息历史里写。幂等键同理：重发可能打到另一个 worker。
