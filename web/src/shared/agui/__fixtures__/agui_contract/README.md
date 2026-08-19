# AG-UI 跨仓契约 golden fixtures（副本）

**事实源：iclip_agent `tests/fixtures/agui_contract/`。本目录是只读副本，改契约
的一方负责同步两仓（ADR-0005）。** 不要在这里单独修改任何 fixture。

## 锁定范围

- 流 fixture（`run_*.json` / `error_*.json`）：`events` 为一次 SSE 响应内按序
  下发的 AG-UI 事件（camelCase wire 形状）。锁定的是**事件序列形状与错误码**。
- `runMode`：该响应预期的 `X-Iclip-Run-Mode` 头（错误流为 null）。
- `restore_response.json`：restore 端点响应的信封形状
  （`headId/messages/members/state/activeRun`）。
- `state` 与消息正文内容为代表性样例，**不锁定应用内部字段**；成员事件
  （`CUSTOM agui.member_event`）的 value 形状在 translator 平移时补充锁定。
- **多模态用户消息**：content 为 AG-UI 规范 parts
  （`text` / `image|video|audio|document{source:{type:'url'|'data'}}`），交错顺序
  即用户发送顺序；engine 内部媒体引用 tag 永不泄漏到 wire。

## 文件清单

| 文件                          | 场景                                                                   |
| ----------------------------- | ---------------------------------------------------------------------- |
| `run_new.json`                | 归因 ①：新 run 正常直流                                                |
| `run_attach_replay.json`      | 归因 ③/④：attach 桥接（回放跨越半条消息 + STATE_SNAPSHOT + live 尾流） |
| `run_terminal_replay.json`    | 归因 ⑦：终态 run 全量回放                                              |
| `run_snapshot_degraded.json`  | 归因 ⑥/⑧：buffer 缺失，DB 事实合成降级快照流                           |
| `error_run_in_progress.json`  | 归因 ②：新消息撞在途 run，显式拒绝                                     |
| `error_active_elsewhere.json` | 归因 ⑤：宽限内探测未中，可重试                                         |
| `error_cancelled.json`        | 场景 12：attach 到已取消 run，回放至取消终态                           |
| `restore_response.json`       | restore 信封 + activeRun 决策                                          |
