"""审计报表的领域模型：筛选范围、一组指标、按维度分行的指标、对话明细与异常。

口径（与 docs/CONTEXT.md「审计口径」一致）：视频只算带数字 ``metadata.shot`` 且挂着对话的
那些行；成片件数按「需求单一件、无单对话各一件」数；镜的身份是（对话，镜号）；交付周期是
一段对话从首次运行到最后一条成片。比率都在这里由原始计数派生，分母为零时是 ``None``。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
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
ANOMALY_KINDS: Final[tuple[AnomalyKind, ...]] = (
    "retry",
    "idle",
    "slow",
    "stuck",
    "spend",
    "task_stuck",
    "deleted",
    "no_task",
    "missing_shot",
)


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
class Spread:
    """一组时长样本的分布，单位秒。"""

    avg: float
    median: float
    p90: float


@dataclass(frozen=True, slots=True)
class UsageTotals:
    requests: int
    input_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    output_tokens: int

    @property
    def total_tokens(self) -> int:
        return (
            self.input_tokens
            + self.cache_read_tokens
            + self.cache_write_tokens
            + self.output_tokens
        )

    @property
    def cache_hit_rate(self) -> float | None:
        """缓存读取在全部输入里的占比。"""

        read_in = self.input_tokens + self.cache_read_tokens + self.cache_write_tokens
        return self.cache_read_tokens / read_in if read_in else None


NO_USAGE: Final = UsageTotals(0, 0, 0, 0, 0)


@dataclass(frozen=True, slots=True)
class Metrics:
    """一格里的全部指标。全体、人、需求单、时段、对话各层都是这一个形状，只是维度键不同。"""

    completed_videos: int
    delivered_tasks: int
    delivered_orphan_conversations: int
    producers: int
    shots: int
    attempts: int
    first_pass_shots: int
    delivered_conversations: int
    cycle_seconds: Spread | None
    video_seconds: Spread | None
    upstream_seconds: Spread | None
    usage: UsageTotals

    @property
    def deliveries(self) -> int:
        """成片件数：有成片的需求单各一件，加没挂需求单却有成片的对话各一件。"""

        return self.delivered_tasks + self.delivered_orphan_conversations

    @property
    def attempts_per_shot(self) -> float | None:
        return self.attempts / self.shots if self.shots else None

    @property
    def first_pass_rate(self) -> float | None:
        return self.first_pass_shots / self.shots if self.shots else None

    @property
    def tokens_per_delivery(self) -> float | None:
        return self.usage.total_tokens / self.deliveries if self.deliveries else None


EMPTY_METRICS: Final = Metrics(
    completed_videos=0,
    delivered_tasks=0,
    delivered_orphan_conversations=0,
    producers=0,
    shots=0,
    attempts=0,
    first_pass_shots=0,
    delivered_conversations=0,
    cycle_seconds=None,
    video_seconds=None,
    upstream_seconds=None,
    usage=NO_USAGE,
)


@dataclass(frozen=True, slots=True)
class UserMetrics:
    user_name: str
    metrics: Metrics


@dataclass(frozen=True, slots=True)
class TaskMetrics:
    task_id: uuid.UUID
    title: str
    metrics: Metrics


@dataclass(frozen=True, slots=True)
class PeriodMetrics:
    period_start: datetime
    metrics: Metrics


@dataclass(frozen=True, slots=True)
class ShotReport:
    shot: int
    attempts: int
    first_pass: bool
    first_at: datetime
    last_at: datetime


@dataclass(frozen=True, slots=True)
class ModelUsage:
    model_name: str
    usage: UsageTotals


@dataclass(frozen=True, slots=True)
class ConversationReport:
    """一段有成片的对话。指标是这段对话的全量，不按时间窗裁。"""

    conversation_id: uuid.UUID
    title: str
    owner_user_id: uuid.UUID
    user_name: str | None
    task_id: uuid.UUID | None
    deleted_at: datetime | None
    started_at: datetime
    delivered_at: datetime
    metrics: Metrics
    shots: Sequence[ShotReport]
    usage: Sequence[ModelUsage]


@dataclass(frozen=True, slots=True)
class ConversationCursor:
    """按（最后成片时刻，对话 id）倒序翻页。"""

    delivered_at: datetime
    conversation_id: uuid.UUID


@dataclass(frozen=True, slots=True)
class Anomaly:
    """一条异常。``ref`` 是「种类:对象」的稳定文本，与 ``at`` 一起构成排序键与游标。"""

    kind: AnomalyKind
    at: datetime
    ref: str
    value: float | None
    threshold: float | None
    conversation_id: uuid.UUID | None
    task_id: uuid.UUID | None
    user_name: str | None
    shot: int | None
    generation_id: uuid.UUID | None


@dataclass(frozen=True, slots=True)
class AnomalyCursor:
    at: datetime
    ref: str


__all__ = [
    "ANOMALY_KINDS",
    "DEFAULT_THRESHOLDS",
    "EMPTY_METRICS",
    "NO_USAGE",
    "Anomaly",
    "AnomalyCursor",
    "AnomalyKind",
    "Bucket",
    "ConversationCursor",
    "ConversationReport",
    "Metrics",
    "ModelUsage",
    "PeriodMetrics",
    "Scope",
    "ShotReport",
    "Spread",
    "TaskMetrics",
    "Thresholds",
    "UsageTotals",
    "UserMetrics",
]
