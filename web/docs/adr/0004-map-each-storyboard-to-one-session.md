# ADR-0004：每个 Storyboard 映射一个独立 Session

## 状态

已采纳（2026-08-02）。运行时形态（单 runtime + thread list 切换）已被 [ADR-0006](0006-storyboard-per-session-runtime-hosts.md) 取代；Task-Session 映射与关系约束仍有效。

## 决策

Storyboard 页面以 `VideoTaskSession` 为唯一 Task-Session 映射。页面加载 `GET /api/video-task-sessions?projectId=...`，再按 `videoTaskId` 精确读取 Task；每条关系渲染一个 Storyboard。页面使用 assistant-ui 官方 provider 与 thread list，以 `session.id` 作为 thread id 切换会话，并通过对应 AG-UI restore 接口恢复消息。

新增 Storyboard 调用 `POST /api/video-task-sessions`。运行统一请求 `/api/agui/agents/storyboard`，`threadId` 等于 `session.id`；前端不发送 `passMedia`，该策略由后端 target 配置拥有。输出保持 Agent 返回的 Markdown 文本，并按 `sessionId` 归属。

## 约束

- 不读取或兼容 `sourceTaskId`。
- 不调用 Storyboard 单例 Session 接口。
- 不按 Project Session 顺序、target、Task 顺序或时间推断关系。
- 不在前端建立 runtime registry、隐藏 runtime host 或 Project 级 AG-UI multiplex；会话选择、messages 与 isRunning 由 assistant-ui 官方 thread 接口管理。
- 测试只覆盖公开 API 和用户可见的创建、切换、运行、输出行为。
