"""transcript 测试替身与两条路的骨架比较。"""

from __future__ import annotations

from typing import Any

from pydantic_ai_harness.step_persistence import ContinuableSnapshot, InMemoryStepStore

from iclip.harness.transcript.store import TranscriptStore
from iclip.platform.transcript.ops import TranscriptTurn


class InMemoryConversationSnapshots(InMemoryStepStore):
    """官方内存 store 加一个按对话取快照的入口，口径与 PgStepStore 一致。"""

    def __init__(self) -> None:
        super().__init__()
        self._by_conversation: list[ContinuableSnapshot] = []

    async def save_snapshot(self, snapshot: ContinuableSnapshot) -> None:
        await super().save_snapshot(snapshot)
        self._by_conversation.append(snapshot)

    async def latest_conversation_snapshot(
        self, *, conversation_id: str, include_interrupted: bool = False
    ) -> ContinuableSnapshot | None:
        found = [
            item
            for item in self._by_conversation
            if item.conversation_id == conversation_id
            and (include_interrupted or item.state == "complete")
        ]
        return found[-1] if found else None


class NoPromptRuns:
    """没有 prompt 映射的历史读取：每个 run 各自成轮。"""

    async def prompt_of_runs(self, conversation_id: str) -> dict[str, str]:
        return {}

    async def prompt_status_of_runs(self, conversation_id: str) -> dict[str, str]:
        return {}


def skeleton(turns: tuple[TranscriptTurn, ...]) -> list[dict[str, Any]]:
    """轮、步、块的可比结构；忽略时间与用量，其余两条路必须逐字相等。"""

    return [
        {
            "turn": (turn.turn_id, turn.ordinal, turn.state, turn.content),
            "steps": [
                {
                    "step": (step.step_id, step.ordinal, step.state),
                    "frames": [
                        (
                            frame.frame_id,
                            frame.kind,
                            getattr(frame, "text", None),
                            getattr(frame, "role", None),
                            getattr(frame, "content", None),
                            getattr(frame, "state", None),
                            # 比较完整工具卡，覆盖参数、display、renderer 和 metadata 的遗漏。
                            getattr(frame, "input", None),
                            getattr(frame, "display", None),
                            getattr(frame, "view", None),
                            getattr(frame, "metadata", None),
                            getattr(frame, "agent_refs", None),
                            # 比较压缩提示内容，避免仅 id 和类型相同而正文不同。
                            getattr(frame, "message", None),
                            getattr(frame, "detail", None),
                        )
                        for frame in step.frames
                    ],
                }
                for step in turn.steps
            ],
        }
        for turn in turns
    ]


def replay(
    live: TranscriptStore, conversation_id: str, agent_id: str
) -> tuple[TranscriptTurn, ...]:
    """从补发日志重放这条流的轮次；轮次交接后实时状态已释放，日志仍在。"""

    replayed = TranscriptStore()
    for batch in live.subscribe_view(conversation_id, agent_id, since=0).batches:
        replayed.append(conversation_id, agent_id, batch.ops)
    return replayed.subscribe_view(conversation_id, agent_id).live_turns


__all__ = ["InMemoryConversationSnapshots", "NoPromptRuns", "replay", "skeleton"]
