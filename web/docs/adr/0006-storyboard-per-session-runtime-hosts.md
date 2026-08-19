# ADR-0006：Storyboard 每个 Session 常驻独立 runtime host

## 状态

已采纳（2026-08-05）。取代 ADR-0004 中「单 runtime + thread list 切换」的运行时形态；ADR-0004 的 Task-Session 映射与关系约束（显式 `VideoTaskSession`、禁止推断、`threadId = session.id`、媒体直传由后端 `pass_media` 决定）继续有效。

## 背景

Storyboard 正式接入后台 run：run 由后端以 `background=True` 持有，前端需要断线重连、刷新后恢复与跨任务的并行运行。原「单 runtime + thread list」形态下切换任务会 `cancelRun()` 掐掉本地流，与后台 run 语义冲突；且 storyboard 侧 restore 只读 `messages`，丢弃了后端唯一恢复决策 `activeRun`（ADR-0005）。

## 决策

- 把 project 页已验证的 AG-UI 装配参数化下沉到 `src/shared/agui/`（`AguiSessionRuntimeProvider` + `recovery.ts`）：原厂 `HttpAgent` 单 URL、传输中断 4 态退避重连、restore 注水后按 `activeRun` 自动触发一次普通 `startRun`（服务端归因 attach）、卸载宏任务延迟 abort。`features/chat` 与 `features/storyboards` 各自以薄包装注入 target、restore 加载器与 target 特有事件消费（member 事件仅 producer team）。
- Storyboard 页面为每条 `VideoTaskSession` 常驻一个独立 runtime host（与 project 页多 host 模型同构），仅 active session 渲染工作台 UI；切换任务不 `cancelRun`、不中断其它 session 的后台流。
- Storyboard restore 消费全量信封：`activeRun`（必需，null 表示纯历史）、`messages`、`state`；输出仍是线性历史，不消费 `headId` 分支与 `members`。
- 提交 prompt 只携带「目标画幅（`brief.ratio`）、目标时长（`brief.durationSeconds`）、需求描述（`brief.requirementDescription`，口播旁白按跨仓约定包含在其中）」与附件索引；不再发送主题/受众/卖点等 Brief 概述字段。
- 选中任务持久化到 sessionStorage（`producer.storyboard.activeSession.{projectId}`）；各 host 经 reporter 上报 `thread.isRunning`，任务书签据此显示运行徽标。

## 约束

- 重连判定唯一来自 restore 的 `activeRun`；不查 runs 列表、不做任何本地归因（ADR-0005）。
- host 数量以任务栏关系数为上界；不引入订阅集合裁剪，除非任务栏规模出现真实问题。
- 不复制 messages / isRunning 出 runtime；运行徽标只经 host 内 reporter 上报布尔值。
