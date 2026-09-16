"""审计报表对外的形状。camelCase；比率由领域模型派生，这里只搬运。"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from iclip.domains.audit.models import (
    Anomaly,
    AnomalyKind,
    ConversationReport,
    Metrics,
    ModelUsage,
    PeriodMetrics,
    ShotReport,
    Spread,
    TaskMetrics,
    UsageTotals,
    UserMetrics,
)


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class SpreadOut(CamelModel):
    """时长分布，单位秒。"""

    avg: float
    median: float
    p90: float


class UsageOut(CamelModel):
    requests: int
    input_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    output_tokens: int
    total_tokens: int
    cache_hit_rate: float | None
    """缓存读取 ÷（新输入 + 缓存读取 + 缓存写入）；没有输入时为空。"""


class MetricsOut(CamelModel):
    """一格指标。每一层都是这个形状，见合同 §12。"""

    deliveries: int
    """成片件数 = 有成片的需求单数 + 没挂需求单却有成片的对话数。"""
    delivered_tasks: int
    delivered_orphan_conversations: int
    completed_videos: int
    producers: int
    shots: int
    attempts: int
    one_take_shots: int
    """只出了一条且成了的镜数。"""
    attempts_per_shot: float | None
    one_take_rate: float | None
    runs: int
    """agent 运行次数，按发起人归属。"""
    delivered_conversations: int
    cycle_seconds: SpreadOut | None
    """对话交付周期：首次运行到最后一条成片。"""
    video_seconds: SpreadOut | None
    """单个视频受理到完成。"""
    upstream_seconds: SpreadOut | None
    """单个视频提交上游到完成。"""
    usage: UsageOut
    tokens_per_delivery: float | None


class UserMetricsOut(CamelModel):
    user_name: str
    metrics: MetricsOut


class TaskMetricsOut(CamelModel):
    task_id: uuid.UUID
    title: str
    metrics: MetricsOut


class PeriodMetricsOut(CamelModel):
    period_start: datetime
    metrics: MetricsOut


class SummaryOut(CamelModel):
    overall: MetricsOut
    users: list[UserMetricsOut]
    tasks: list[TaskMetricsOut]
    series: list[PeriodMetricsOut] | None
    """只在给了 ``bucket`` 时有。"""


class ShotOut(CamelModel):
    shot: int
    attempts: int
    one_take: bool
    first_at: datetime
    last_at: datetime


class ModelUsageOut(CamelModel):
    model_name: str
    usage: UsageOut


class ConversationAuditOut(CamelModel):
    """一段有成片的对话；指标与镜、用量都是这段对话的全量。"""

    conversation_id: uuid.UUID
    title: str
    owner_user_id: uuid.UUID
    user_name: str | None
    task_id: uuid.UUID | None
    deleted_at: datetime | None
    started_at: datetime
    delivered_at: datetime
    metrics: MetricsOut
    shots: list[ShotOut]
    usage: list[ModelUsageOut]


class AuditConversationsOut(CamelModel):
    items: list[ConversationAuditOut]
    next_cursor: str | None


class AnomalyOut(CamelModel):
    kind: AnomalyKind
    at: datetime
    value: float | None
    threshold: float | None
    conversation_id: uuid.UUID | None
    task_id: uuid.UUID | None
    user_name: str | None
    shot: int | None
    generation_id: uuid.UUID | None


class AnomaliesOut(CamelModel):
    items: list[AnomalyOut]
    next_cursor: str | None


def spread_out(spread: Spread | None) -> SpreadOut | None:
    return (
        None if spread is None else SpreadOut(avg=spread.avg, median=spread.median, p90=spread.p90)
    )


def usage_out(usage: UsageTotals) -> UsageOut:
    return UsageOut(
        requests=usage.requests,
        input_tokens=usage.input_tokens,
        cache_read_tokens=usage.cache_read_tokens,
        cache_write_tokens=usage.cache_write_tokens,
        output_tokens=usage.output_tokens,
        total_tokens=usage.total_tokens,
        cache_hit_rate=usage.cache_hit_rate,
    )


def metrics_out(metrics: Metrics) -> MetricsOut:
    return MetricsOut(
        deliveries=metrics.deliveries,
        delivered_tasks=metrics.delivered_tasks,
        delivered_orphan_conversations=metrics.delivered_orphan_conversations,
        completed_videos=metrics.completed_videos,
        producers=metrics.producers,
        shots=metrics.shots,
        attempts=metrics.attempts,
        one_take_shots=metrics.one_take_shots,
        attempts_per_shot=metrics.attempts_per_shot,
        one_take_rate=metrics.one_take_rate,
        runs=metrics.runs,
        delivered_conversations=metrics.delivered_conversations,
        cycle_seconds=spread_out(metrics.cycle_seconds),
        video_seconds=spread_out(metrics.video_seconds),
        upstream_seconds=spread_out(metrics.upstream_seconds),
        usage=usage_out(metrics.usage),
        tokens_per_delivery=metrics.tokens_per_delivery,
    )


def user_metrics_out(item: UserMetrics) -> UserMetricsOut:
    return UserMetricsOut(user_name=item.user_name, metrics=metrics_out(item.metrics))


def task_metrics_out(item: TaskMetrics) -> TaskMetricsOut:
    return TaskMetricsOut(task_id=item.task_id, title=item.title, metrics=metrics_out(item.metrics))


def period_metrics_out(item: PeriodMetrics) -> PeriodMetricsOut:
    return PeriodMetricsOut(period_start=item.period_start, metrics=metrics_out(item.metrics))


def _shot_out(shot: ShotReport) -> ShotOut:
    return ShotOut(
        shot=shot.shot,
        attempts=shot.attempts,
        one_take=shot.one_take,
        first_at=shot.first_at,
        last_at=shot.last_at,
    )


def _model_usage_out(item: ModelUsage) -> ModelUsageOut:
    return ModelUsageOut(model_name=item.model_name, usage=usage_out(item.usage))


def conversation_out(report: ConversationReport) -> ConversationAuditOut:
    return ConversationAuditOut(
        conversation_id=report.conversation_id,
        title=report.title,
        owner_user_id=report.owner_user_id,
        user_name=report.user_name,
        task_id=report.task_id,
        deleted_at=report.deleted_at,
        started_at=report.started_at,
        delivered_at=report.delivered_at,
        metrics=metrics_out(report.metrics),
        shots=[_shot_out(shot) for shot in report.shots],
        usage=[_model_usage_out(item) for item in report.usage],
    )


def anomaly_out(anomaly: Anomaly) -> AnomalyOut:
    return AnomalyOut(
        kind=anomaly.kind,
        at=anomaly.at,
        value=anomaly.value,
        threshold=anomaly.threshold,
        conversation_id=anomaly.conversation_id,
        task_id=anomaly.task_id,
        user_name=anomaly.user_name,
        shot=anomaly.shot,
        generation_id=anomaly.generation_id,
    )


__all__ = [
    "AnomaliesOut",
    "AnomalyOut",
    "AuditConversationsOut",
    "ConversationAuditOut",
    "MetricsOut",
    "ModelUsageOut",
    "PeriodMetricsOut",
    "ShotOut",
    "SpreadOut",
    "SummaryOut",
    "TaskMetricsOut",
    "UsageOut",
    "UserMetricsOut",
    "anomaly_out",
    "conversation_out",
    "metrics_out",
    "period_metrics_out",
    "task_metrics_out",
    "user_metrics_out",
]
