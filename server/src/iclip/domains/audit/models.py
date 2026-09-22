"""审计查询的入口形状：筛选范围、异常阈值与两种翻页游标。报表的读模型见 schemas.py。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal

Bucket = Literal["day", "week", "month"]

AnomalyKind = Literal[
    "retry",
    "idle",
    "slow",
    "stuck",
    "spend",
    "task_stuck",
    "deleted",
    "no_task",
    "missing_shot",
]


@dataclass(frozen=True, slots=True)
class Scope:
    """一次查询的筛选范围。时间窗 ``[since, until)`` 作用在各指标自己的锚点上，见各查询。"""

    since: datetime | None = None
    until: datetime | None = None
    user_name: str | None = None
    task_id: uuid.UUID | None = None


@dataclass(frozen=True, slots=True)
class Thresholds:
    """异常判定的阈值；P90 / P95 一类按筛选范围现算，不在这里。"""

    retry_over: int = 2
    """单镜生成次数超过这个数算反复重试。"""
    idle_hours: int = 24
    """有运行、无成片、最近活动距今超过这么多小时算空转。"""
    stuck_hours: int = 1
    """视频停在 ``submitted`` 超过这么多小时算悬挂。"""
    task_conversations: int = 3
    """需求单挂了至少这么多段对话还没有成片算卡住。"""


DEFAULT_THRESHOLDS: Final = Thresholds()


@dataclass(frozen=True, slots=True)
class ConversationCursor:
    """按（最后成片时刻，对话 id）倒序翻页。"""

    delivered_at: datetime
    conversation_id: uuid.UUID


@dataclass(frozen=True, slots=True)
class AnomalyCursor:
    """按（发生时刻，「种类:对象」）倒序翻页。"""

    at: datetime
    ref: str


__all__ = [
    "DEFAULT_THRESHOLDS",
    "AnomalyCursor",
    "AnomalyKind",
    "Bucket",
    "ConversationCursor",
    "Scope",
    "Thresholds",
]
