# vendor：transcript 协议数据层

本目录来自 `@moonshot-ai/transcript` 0.0.2，仓库为 [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) 的 `packages/transcript`；许可证见 [LICENSE](LICENSE)。本仓保留了协议扩展与裁剪，不是上游的逐字副本。

## 做过的改写

- 工具帧增加 `metadata`：声明位于 [model/frame.ts](model/frame.ts)，接收校验位于 [contract/schema.ts](contract/schema.ts)，承载面向用户的工具结果。
- 轮头部和用户文本帧使用 `content` 保存原始消息 part；类型、schema 与 [ops/apply.ts](ops/apply.ts) 的相等判断共同维护这一扩展。上游的 `triggerPromptId` 保留在 [model/turn.ts](model/turn.ts)、schema 与相等判断里，乐观气泡按它认领。
- 未引入上游 `history/`。历史投影由[后端 transcript](../../../../../server/src/iclip/harness/transcript/from_messages.py)生成，相关上游 history 测试未保留。
- [测试目录](__tests__/)使用相对导入，并按本仓的消息形状调整测试数据。

## 维护边界

日常业务适配、连接封装与应用状态放在[上级目录](../)，不在 vendor 内修改。上游同步或跨端协议变更需要修改本目录时，逐项核对并保留上述本仓扩展，不直接覆盖整目录。

协议变更同时核对前端 schema、类型、操作投影和[后端协议类型](../../../../../server/src/iclip/platform/transcript/wire.py)，更新对应层的契约与行为测试。保留上游许可证；字段是否接受、保留或丢弃以 schema 为准。
