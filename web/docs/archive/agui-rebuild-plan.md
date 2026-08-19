# AG-UI 接入重建实施计划（前端）

状态：**已完成并归档（2026-08-04）**。M1–M4 全部落地：`pnpm ci:check` 614 tests 绿，`agui/` 三文件落地、旧传输恢复层删净，`backend_api.md` §4 与 `state-management.md` 已按 ADR-0005 修订。长期事实已沉淀进 [ADR-0005](../adr/0005-stock-agui-client-backend-attribution.md)、`docs/backend_api.md` §4 与 `docs/state-management.md`；本文仅作留档（非事实源）。双端联调人工走查（后端计划 §4 场景 4/6/7/8/12）未在实施会话内执行，发布前补跑 ｜ 后端对应留档：iclip_agent `docs/archive/agui-interface-rebuild-plan.md`（wire 契约与 17 条行为契约）

## 1. 目标结构

```
src/features/chat/agui/
├── history.ts     # ThreadHistoryAdapter：restore 注水 + activeRun 透传
├── recovery.ts    # 4 态 reducer（idle|streaming|interrupted|degraded）
│                  # + 指数退避 + 三码分诊表
└── provider.tsx   # useAgUiRuntime 装配（原厂 HttpAgent 单 URL）
                   # + 挂载时 activeRun ⇒ 自动触发一次 startRun
                   # + interrupted/重连期间禁用发送框
```

原则：官方包纯装配。不子类化 HttpAgent、不换 fetch、不用 `unstable_*`/protected API、不解析 AG-UI 事件、不做重连路由决策、不做跨标签页协调。

## 2. 文件处置清单

| 现文件（`src/features/chat/runtime/`） | 处置 |
| --- | --- |
| `project-assistant-runtime.ts`（URL 换轨 + 冻结中间件） | 删除，重试职责入 `recovery.ts` |
| `project-assistant-session.ts`（`pendingRejoin` 门闩） | 删除，注水职责入 `history.ts` |
| `project-restore-history.ts`（runs 列表判定） | 删除，决策改由 restore `activeRun` 下发 |
| `project-runtime-handover.ts`（隐式状态机） | 删除，入 `recovery.ts` 显式 reducer |
| `ProjectAssistantRuntimeProvider.tsx` 中固定 1s 重试与 rejoin 死胡同 | 重写入 `provider.tsx` |
| 投影层：`project-agui-messages` / `project-member-segments` / `project-message-parts` / `project-ask-user-question-parts` / `project-state.*` / `project-conversation-timeline`（含测试） | **保留**，平移或原地引用 |

## 3. 行为要点（细节见后端计划 §4 十七条行为契约）

- 恢复 = restore（注水 + `activeRun`）→ 自动 startRun（后端归因 attach）。2 请求。
- 闪断重试 = 退避后重发普通 startRun；`ACTIVE_ELSEWHERE` 同治。退避：1s 起指数 ×2 + 抖动，上限 5 次后 `degraded` + 手动重试。
- `RUN_IN_PROGRESS`：消息标记未送达留在线程，提示等待重连完成；不自动重发。
- `CANCELLED`：呈现「已停止」中性态。
- 快照兜底（`snapshot` mode）对前端不可见——就是一条正常合法流。
- 重连期间（`interrupted`）发送框禁用并显示重连提示。

## 4. 测试计划

- `recovery.ts` reducer 迁移表穷举单测（含「窗口期发消息被禁写/被拒绝」「退避上限进 degraded」用例）。
- `history.ts` 注水往返用例：restore fixture → 注水 → 下一次出站 input 的历史消息 id 与 fixture 一致（id 空间往返契约）。
- golden fixtures 副本置于 `src/features/chat/agui/__fixtures__/agui_contract/`，文件头标注「来源 iclip_agent tests/fixtures/agui_contract/，改契约方负责同步」。
- 投影层现有测试随文件保留，全部继续 PASS。
- 门禁：每里程碑 `pnpm ci:check` 绿。

## 5. 里程碑（与后端计划对齐）

| 里程碑 | 内容 | 验收 |
| --- | --- | --- |
| M1 契约锁定 | 双仓 ADR + 本计划 + fixtures 副本机制确定 | 文档齐 |
| M3 前端切换 | 新 `agui/` 三文件落地，Provider 切换，删除处置清单所列文件 | `pnpm ci:check` 绿；双端联调走查行为契约场景 4/6/7/8/12 |
| M4 清理定稿 | 更新 `docs/backend_api.md` 与 workspace 契约描述，归档本计划 | 仓内无 `pendingRejoin`/`rejoin` 残留引用 |

（M2 为后端里程碑，本仓无动作。）
