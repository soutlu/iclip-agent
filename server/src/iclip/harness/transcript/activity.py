"""将 JobQueue.activities 选出的消息状态映射为会话活动，不查询数据库。

busy、attention 与最近结果为独立字段；等待审批时 busy 仍为真。
协议按 approval > question > none 确定待处理事项的优先级。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    # 仅类型检查时导入，避免 jobs 的运行时循环依赖。
    from iclip.harness.jobs import JobStatus

PendingInteraction = Literal["none", "approval", "question"]
"""最高优先级的待处理事项。"""

LastTurnReason = Literal["completed", "failed", "aborted"]
"""最近完成轮次的结果。"""


@dataclass(frozen=True, slots=True)
class ActivityState:
    """会话活动的三个独立状态维度。"""

    busy: bool
    """是否有活跃轮次。"""

    pending_interaction: PendingInteraction = "none"
    """待处理事项；审批等待期间 busy 仍为真。"""

    last_turn_reason: LastTurnReason | None = None
    """最近完成轮次的结果，尚无结果时为 None。"""


IDLE = ActivityState(busy=False)
"""未运行且无待处理事项的会话状态。"""


def activity_of(status: JobStatus | None) -> ActivityState:
    """将消息状态映射为会话活动，缺少记录时使用 None。"""

    match status:
        case "running" | "steered":
            return ActivityState(busy=True)
        case "awaiting":
            return ActivityState(busy=True, pending_interaction="approval")
        case "completed" | "failed" | "aborted":
            return ActivityState(busy=False, last_turn_reason=status)
        case _:
            # queued 不决定当前会话活动。
            return IDLE


__all__ = [
    "IDLE",
    "ActivityState",
    "LastTurnReason",
    "PendingInteraction",
    "activity_of",
]
