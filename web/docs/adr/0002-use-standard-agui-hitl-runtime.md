# 使用标准 AG-UI HITL Runtime，不引入 Agno 前端协议

> **状态（2026-08-27）**：本决策描述的子系统已随前端重写整体删除，页面层重建时按本文重新落地或另开 ADR 取代。

日期：2026-07-15 ｜ 状态：已实施

## 决策

Producer 前端继续只认识 AG-UI，不安装或实现 Agno 专属 HITL client。依赖按兼容簇升级到：

- `@ag-ui/client` 0.0.57
- `@assistant-ui/react` 0.14.26
- `@assistant-ui/react-ag-ui` 0.0.44
- `assistant-stream` 0.3.25

HITL 读取使用公开 `useAgUiInterrupts()`，提交使用 `useAgUiSubmitInterruptResponses()`；不再暴露自建 runtime context，也不再调用 `unstable_*` interrupt API。

restore 的 pending 状态从后端 AG-UI messages 的 `metadata.custom.agui.interrupts` 恢复。官方 `fromAgUiMessages()` 是标准 user/system/assistant/reasoning、附件、metadata/status 的转换基线；Productor 转换层只保留框架无法知道的职责：成员 run 的工具结果归属、内部 confirmation tool 过滤和孤立 tool result 过滤。前端不再定位最后一条 assistant message、不再注入 metadata，也不再合成 interrupt placeholder 或 ask tool-call。

拒绝工具审批不是取消 run：resume entry 始终提交 `status: "resolved"`，业务 payload 用 `approved: false` 表达拒绝；`cancelled` 只保留给真正的 run 取消语义。

## 后果

- live 与 restore 使用同一 assistant-ui AG-UI interrupt store，消除自维护的并行中断状态。
- assistant-ui 包升级必须作为一个兼容簇执行，并同时跑 chat tests、typecheck 和 build。
- 后端通过 contract tests 保证 restore message metadata、placeholder 与 ask anchor；前端不合成、不修复，也不再实现一套重复的交叉校验。
