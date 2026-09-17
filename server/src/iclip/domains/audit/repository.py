"""审计报表的读取协议。实现在 reports_pg.py，服务层只依赖这里。"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

from iclip.domains.audit.models import (
    Anomaly,
    AnomalyCursor,
    AnomalyKind,
    AttemptBucket,
    Bucket,
    ConversationCursor,
    ConversationReport,
    Metrics,
    PeriodMetrics,
    Scope,
    TaskMetrics,
    Thresholds,
    UserMetrics,
)


class AuditReports(Protocol):
    async def overall(self, scope: Scope) -> Metrics:
        """整个筛选范围一格。"""
        ...

    async def by_user(self, scope: Scope) -> Sequence[UserMetrics]:
        """每个有动静的人一行，成片件数多的排前面。"""
        ...

    async def by_task(self, scope: Scope) -> Sequence[TaskMetrics]:
        """每张有动静的需求单一行；没挂需求单的对话不在这里。"""
        ...

    async def by_period(
        self, scope: Scope, *, bucket: Bucket, timezone: str
    ) -> Sequence[PeriodMetrics]:
        """按 ``timezone`` 的日 / 周 / 月切时段，每段一行，早的排前面。"""
        ...

    async def attempt_distribution(self, scope: Scope) -> Sequence[AttemptBucket]:
        """出片次数分布，次数少的排前面；时间窗作用在该镜首次出片时刻上。不封顶。"""
        ...

    async def conversations(
        self, scope: Scope, *, limit: int, after: ConversationCursor | None
    ) -> Sequence[ConversationReport]:
        """有成片的对话，最后成片晚的排前面；时间窗作用在最后成片时刻上。"""
        ...

    async def anomalies(
        self,
        scope: Scope,
        thresholds: Thresholds,
        *,
        kinds: Sequence[AnomalyKind] | None,
        limit: int,
        after: AnomalyCursor | None,
    ) -> Sequence[Anomaly]:
        """异常按发生时刻倒序；``kinds`` 为 ``None`` 时全部种类都要。"""
        ...


__all__ = ["AuditReports"]
