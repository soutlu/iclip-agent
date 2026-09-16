# ADR-0026：对话用量按（对话，模型）累加落表，不动运行表

- 状态：已接受（2026-09-15）
- 关联：[ADR-0006](0006-durable-runs.md)（运行事实与快照不变）、[ADR-0012](0012-subagent-transcript.md)（子代理运行归到同一段对话）
- 修订 [CONTEXT.md](../CONTEXT.md) 新增术语「对话用量」；[architecture.md](../architecture.md) 持久化表补一行。

## 背景

要审计每张需求单、每段对话花了多少模型 token。token 一直只在 `agent_runtime.snapshots.messages` 的 JSON 里：每条 `ModelResponse` 带 usage，但快照存的是整段历史，一段对话第 N 轮的快照包含前 N-1 轮的全部响应，直接汇总会重复计数 N 遍，还要先解析几 MB 的文本。`events` 的 metadata 是静态 str→str，不含用量；`runs` 是 harness 的 `RunRecord` 形状，加列要在协议之外维护。

## 决策

### 1. 新表 `agent_runtime.conversation_usage`，一段对话 × 一个模型一行

列：`requests`、`input_tokens`、`cache_read_tokens`、`cache_write_tokens`、`output_tokens`、`first_at`、`last_at`。模型每答一次，一条 `INSERT … ON CONFLICT DO UPDATE SET x = x + EXCLUDED.x` 累加，多 worker 并发下不读改写，时间用数据库时钟。行数 = 对话数 × 模型数，不随轮次增长。

### 2. 记账点在模型请求链最内层

`harness/usage_ledger.py` 的 `UsageLedger` 是一个 capability，`wrap_model_request` 拿到响应就记，ordering 声明 innermost。放这里而不放 `after_model_request`，是因为外层 capability 抛 `ModelRetry` 会跳过 `after_model_request`，那次已付费的响应就漏了；innermost 让它们都先经过账本。做法与 harness 自带的 `SpendLimits` 相同，不用它是因为它的计数器只有 total tokens，分不出缓存。

### 3. 归属对话来自运行依赖，模型名来自配置

对话 id 由组合根注入的回调从 `AgentRunDeps.conversation_id` 取：子代理的 `ctx.conversation_id` 会重生成，只有依赖里继承的那份稳定。模型名用 `ctx.model.model_name`，与子代理档案记的是同一个字符串；provider 回报的名字可能带版本后缀，会把同一个模型拆成多行。

### 4. 写台账失败只记日志

响应已经付费，不能因为账本写不进去作废它；也不静默吞掉，`error` 级日志带 `run_id`、`conversation_id`、`model_name`。续跑从快照恢复消息，不重发已完成的请求，所以不需要幂等 token；崩溃时在途那一次请求丢失不计。

## 取舍

- **接受**：只有对话总量，没有轮次粒度与时间趋势。将来要细，按 run 落行的表另加，本表不改。
- **接受**：标题生成、压缩摘要、视频理解这三处模型调用不经过 Agent 的请求链，不计。
- **接受**：需求单粒度沿 `iclip.conversations.task_id` 汇总，对话换挂需求单时历史跟着走。
- **不做**：单价与金额。表里没有 usd 列，要算钱在查询侧乘单价。
- **不做**：改 `runs` 表。它的形状跟着 harness 的 `RunRecord`，本仓只负责存。
