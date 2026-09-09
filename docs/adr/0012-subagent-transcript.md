# ADR-0012: 子代理各自一条 transcript 流，父子关联记在副作用账本

- 状态：已接受（2026-09-04）
- 补充 **[ADR-0005](0005-transcript-protocol.md)**：协议的 Agent 层从只有 `main` 扩到子代理；决策 1「两条路逐字同构」与决策 2「不设 `agent_name`」对子代理同样成立。
- **[ADR-0006](0006-durable-runs.md)**：子代理的运行记录、事件与快照同样由官方 `StepPersistence` 写入，本文不另设存储。

## 背景

kimi 协议里每个 agent 有自己的 transcript 流，父流靠工具帧上的 `agentRefs` 与 kind 为 `subagent` 的 task 指向子代理，客户端点开时才按 agent_id 拉页订阅。kimi 网页端只读这两样，`parentAgentId` 从未被读；它的历史重建不恢复 `agentRefs`，刷新后父卡上的链就没有了。

官方 harness 的 `SubAgents` 把子运行当一次普通工具调用：`delegate_task` 起子运行时不传 run id 与会话 id，子运行事件只留了 `event_stream_handler` 与 `shared_capabilities` 两个口子，父工具调用与子运行之间没有持久化的关联；ACP 适配器也只把它当一张带字符串结果的工具卡。

## 决策

### 1. 每个子代理一条独立 transcript 流，一次 delegate 等于一轮

子代理流与主流由同一个投影器产生，轮 / 步 / 块规则不变；轮 id 恒为 `t1`，用户块就是派下去的任务文本。子代理事件在子运行内部由挂在 `shared_capabilities` 上的镜像能力收集：`on_event` 入队、`wrap_run` 消费，运行结束补 `AgentRunResultEvent`。子运行不继承父的取消令牌，父被停止时子侧收到的是 `CancelledError`，镜像能力自己把它转成投影器的取消路径，否则子流永远停在 running 而历史标 failed。

### 2. 子代理的 agent_id 就是它落库的 run id

子代理的 `StepPersistence` 不设 `agent_name`：设了落库键会变成编码串，与消息上的 `run_id` 成两套，历史侧按消息 run id 查不到终态事件。名字放进 `StepPersistence.metadata`。这样冷加载时按 agent_id 取数不需要任何新持久化：快照与事件按 run id 直接取，子代理列表按 `parent_run_id` 列。

### 3. 父工具调用到子运行的映射记在官方副作用账本

父侧一个按 run 构造的能力在 `delegate_task` 执行完毕后调 `annotate_tool_effect(effect_summary=子 run id)`，挂在父 run 的那次工具调用上。历史重建遇到 `delegate_task` 调用就查账本补 `agentRefs`，与实时逐字相同，ADR-0005 的对齐测试不开例外。父侧与子侧之间用 contextvar 传一个可变对象：子运行在新 Task 里跑，contextvar 是复制下去的，只有改同一个对象父侧才看得见。

### 4. `agentRefs`、task 与 agents 列表由父流投影器产生

轮 / 步 / 块 id 只有父投影器知道，子侧不写父流。task 的终态与摘要取 `delegate_task` 的工具返回，历史取同一个 `ToolReturnPart`。agents 列表从 task 列表推出，实时与历史共用一个函数。

## 取舍

- **不学 kimi 只做实时链。** 刷新前点得开、刷新后点不开，对齐测试也会当场红。代价是每次 delegate 多一次账本写入。
- **不用 `ToolReturn.metadata` 传子 id。** ADR-0007 决策 6 把它定为给人看的形状，会原样进工具帧。
- **接受子运行中途崩、账本没写上的情况。** agents 列表里有它、父卡上没有链；tool_effect 的状态本身也是 `unknown_after_crash`。
- **接受重新生成末轮时子代理随 run 一起消失。** 列表从消息里的 run id 出发按 `parent_run_id` 列，被截掉的轮自然不在。
- **子代理暂不做上下文仪表与压缩。** 子运行没有配置的窗口上限，与主 agent「未配置窗口不启用」同一条件。
