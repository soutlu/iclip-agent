"""一段对话的历史：从落库的运行快照读回来，换成前端形状。

前端刷新或重新登录之后手里什么都没有，历史只能从这里给。取的就是**这段对话最新的
那份完整快照**——快照里是全部消息（客户端每轮把整段历史送上来，引擎再把新消息追加
进去），所以拿一份就够，不必把多次运行拼起来。

快照按运行分片存，但「最新的一份」跟它属于哪次运行无关：一次运行崩在留下快照之前
就是没留下，往前那份仍然是这段对话最新的存档。

出去之前有两处加工。媒体 tag 换回前端形状（见 ``harness.media``）。system 消息不
出去：agent 自己的提示词走的是 ``instructions``，本来就不在消息里，这里挡的是客户端
当初随请求体塞进来的那种——它不是对话内容。

其余原样：上下文里有什么，前端就照着显示什么。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from ag_ui.core import DeveloperMessage, SystemMessage
from pydantic_ai.ui.ag_ui import AGUIAdapter
from pydantic_ai_harness.step_persistence import ContinuableSnapshot

from iclip.harness.media import MediaCodec


class ConversationSnapshots(Protocol):
    """按对话取最新存档的那一口。只要这一个方法，不要整个 step store。"""

    async def latest_conversation_snapshot(
        self, *, conversation_id: str
    ) -> ContinuableSnapshot | None: ...


@dataclass(frozen=True, slots=True)
class HistoryReader:
    """按对话 id 读历史。返回的是可直接进 JSON 的 AG-UI 消息。"""

    snapshots: ConversationSnapshots
    media: MediaCodec

    async def read(self, conversation_id: str) -> tuple[dict[str, Any], ...]:
        """读这段对话的历史；一份存档都没有就是空的。"""

        snapshot = await self.snapshots.latest_conversation_snapshot(
            conversation_id=conversation_id
        )
        if snapshot is None:
            return ()
        dumped = AGUIAdapter.dump_messages(snapshot.messages)
        return tuple(
            message.model_dump(by_alias=True, exclude_none=True)
            for message in self.media.restore(dumped)
            if not isinstance(message, SystemMessage | DeveloperMessage)
        )


__all__ = ["HistoryReader"]
