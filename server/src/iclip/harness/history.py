"""一段对话的历史：从落库的运行快照读回来，换成前端形状。

前端刷新或重新登录之后手里什么都没有，历史只能从这里给。取最近一次留下完整快照
的运行——那份快照里就是这段对话的全部消息（客户端每轮把整段历史送上来，引擎再把
新消息追加进去），所以不必把多次运行拼起来。

出去之前有两处加工。媒体 tag 换回前端形状（见 ``harness.media``）。system 消息不
出去：agent 自己的提示词走的是 ``instructions``，本来就不在消息里，这里挡的是客户端
当初随请求体塞进来的那种——它不是对话内容。

其余原样：上下文里有什么，前端就照着显示什么。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ag_ui.core import DeveloperMessage, SystemMessage
from pydantic_ai.ui.ag_ui import AGUIAdapter
from pydantic_ai_harness.step_persistence import StepStore

from iclip.harness.media import MediaCodec


@dataclass(frozen=True, slots=True)
class HistoryReader:
    """按对话 id 读历史。返回的是可直接进 JSON 的 AG-UI 消息。"""

    step_store: StepStore
    media: MediaCodec

    async def read(self, conversation_id: str) -> tuple[dict[str, Any], ...]:
        """读这段对话的历史；一条运行都没跑过就是空的。

        从最近的运行往回找第一份完整快照：最后那次运行可能崩在半路（进程重启、
        模型报错），它没留下完整快照，但上一次留下了，历史不该因此整段消失。
        """

        runs = await self.step_store.list_runs(conversation_id=conversation_id)
        for record in reversed(runs):
            snapshot = await self.step_store.latest_snapshot(run_id=record.run_id)
            if snapshot is None:
                continue
            dumped = AGUIAdapter.dump_messages(snapshot.messages)
            return tuple(
                message.model_dump(by_alias=True, exclude_none=True)
                for message in self.media.restore(dumped)
                if not isinstance(message, SystemMessage | DeveloperMessage)
            )
        return ()


__all__ = ["HistoryReader"]
