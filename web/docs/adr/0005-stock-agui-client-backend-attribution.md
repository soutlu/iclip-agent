# 前端只装配官方 AG-UI 组件，重连决策整体移交后端

> **状态（2026-08-27）**：本决策描述的子系统已随前端重写整体删除，页面层重建时按本文重新落地或另开 ADR 取代。

日期：2026-08-04 ｜ 状态：已实施（实施计划留档见 [docs/archive/agui-rebuild-plan.md](../archive/agui-rebuild-plan.md)）

## 决策

Producer 的 AG-UI 接入重建为官方包纯装配，自有代码只保留框架无法知道的产品
职责。与 iclip_agent ADR-0005（单 SSE 端点 + 服务端归因）互为对偶。

`HttpAgent` 用原厂：不子类化、不替换 fetch、不使用任何 `unstable_*` 或
protected API，单一 URL 指向唯一 run 端点。「这次 startRun 是新 run 还是重
连」由后端按 input 内容归因——前端不再有 URL 换轨、`pendingRejoin` 门闩、
frozen/warming runtime 原子换代与 runs 列表判定，这四套机制全部删除。断线
重连退化为一个动作：**退避后再触发一次普通 startRun**。

历史与恢复走官方 `ThreadHistoryAdapter`：`load()` 调 restore 注水消息与状
态，并透传后端唯一恢复决策 `activeRun`；挂载时发现 `activeRun` 即自动触发
一次 startRun（后端归因为 attach 桥接）。全程 2 个请求。

连接状态收敛为一个 4 态 reducer：`idle | streaming | interrupted(attempt)
| degraded`。传输闪断与 `ACTIVE_ELSEWHERE` 同治（指数退避 + 抖动，超上限进
`degraded` 给手动重试）；`RUN_IN_PROGRESS` 为终态，消息留本地可重发；
`CANCELLED` 呈现为中性「已停止」。重连期间发送框禁用，是「永不静默吞消息」
不变式的第一道防线（服务端拒绝为第二道）。前端不读取除上述三码之外的任何
错误分型，也不做跨标签页协调。

投影层是资产、原样保留：成员段归属、消息 parts、ask-user-question parts、
通用 AG-UI state 读取、会话时间线。业务事实独立从 Session Workspace、assets
与 generations 读取；ADR-0002 的 HITL runtime 决策不变。

## 后果

- 删除 `src/features/chat/runtime/` 中传输恢复四件套：
  `project-assistant-runtime.ts`（URL 换轨）、`project-assistant-session.ts`
  （门闩，历史吞消息 bug 所在）、`project-restore-history.ts`（前端 runs 判
  定）、`project-runtime-handover.ts`（隐式状态机）及其测试；Provider 中固定
  1s 重试与 rejoin 错误死胡同一并移除。
- 新增仅三文件：`features/chat/agui/{history.ts, recovery.ts, provider.tsx}`。
  归因、错误分型、快照兜底全部是后端行为，前端复杂度不随场景数增长。
- `@ag-ui/client` / `@assistant-ui/*` 升级面收缩到公开 API；将来上游支持
  connect 渲染入口时，切换为纯触发机制替换，wire 零变化。
- 契约由 iclip_agent `tests/fixtures/agui_contract/` golden fixtures 锁定，
  本仓持带来源标注的副本供单测消费；改契约的一方负责同步。
- 本 ADR 取代 iclip_agent ADR-0006（原编号 0003）中描述的前端「frozen/warming
  runtime 原子换代」机制；ADR-0001（同源 `/api` 代理）、ADR-0002（HITL）不受影响。
