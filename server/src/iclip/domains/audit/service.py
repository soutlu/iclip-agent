"""审计报表用例：只有治理者能看；把查询参数整理成筛选范围，负责游标与参数校验。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from iclip.common.errors import PermissionDenied, ValidationFailed
from iclip.domains.audit.models import (
    DEFAULT_THRESHOLDS,
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
from iclip.domains.audit.repository import AuditReports
from iclip.domains.identity.public import Principal

MANAGE_PERMISSION: Final = "users:manage"
MAX_LIST_LIMIT: Final = 100


@dataclass(frozen=True, slots=True)
class Summary:
    overall: Metrics
    users: Sequence[UserMetrics]
    tasks: Sequence[TaskMetrics]
    series: Sequence[PeriodMetrics] | None
    attempt_distribution: Sequence[AttemptBucket]
    """出片次数分布，只给全体一档；按人、按需求单的行上没有这份数据。"""


@dataclass(frozen=True, slots=True)
class ConversationsPage:
    items: Sequence[ConversationReport]
    next_cursor: str | None


@dataclass(frozen=True, slots=True)
class AnomaliesPage:
    items: Sequence[Anomaly]
    next_cursor: str | None


def _as_utc(moment: datetime | None) -> datetime | None:
    """无时区输入按 UTC 解释，避免与 timestamptz 比较时驱动报错。"""

    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=UTC)


def _scope(
    *,
    since: datetime | None,
    until: datetime | None,
    user_name: str | None,
    task_id: uuid.UUID | None,
) -> Scope:
    since, until = _as_utc(since), _as_utc(until)
    if since is not None and until is not None and since >= until:
        raise ValidationFailed("since 必须早于 until")
    return Scope(since=since, until=until, user_name=user_name, task_id=task_id)


def _check_timezone(name: str) -> str:
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValidationFailed(f"timezone 不是一个可识别的时区名: {name}") from exc
    return name


def _check_limit(limit: int) -> None:
    if not 1 <= limit <= MAX_LIST_LIMIT:
        raise ValidationFailed(f"limit 必须在 1 到 {MAX_LIST_LIMIT} 之间")


def _split_cursor(cursor: str) -> tuple[datetime, str]:
    stamp, separator, rest = cursor.partition("|")
    if not separator or not rest:
        raise ValidationFailed("cursor 不是一个有效的翻页位置")
    try:
        return datetime.fromisoformat(stamp), rest
    except ValueError as exc:
        raise ValidationFailed("cursor 不是一个有效的翻页位置") from exc


def _decode_conversation_cursor(cursor: str | None) -> ConversationCursor | None:
    if cursor is None:
        return None
    delivered_at, raw_id = _split_cursor(cursor)
    try:
        return ConversationCursor(delivered_at=delivered_at, conversation_id=uuid.UUID(raw_id))
    except ValueError as exc:
        raise ValidationFailed("cursor 不是一个有效的翻页位置") from exc


def _encode_conversation_cursor(report: ConversationReport) -> str:
    return f"{report.delivered_at.isoformat()}|{report.conversation_id}"


def _decode_anomaly_cursor(cursor: str | None) -> AnomalyCursor | None:
    if cursor is None:
        return None
    at, ref = _split_cursor(cursor)
    return AnomalyCursor(at=at, ref=ref)


def _encode_anomaly_cursor(anomaly: Anomaly) -> str:
    return f"{anomaly.at.isoformat()}|{anomaly.ref}"


class AuditService:
    def __init__(self, reports: AuditReports) -> None:
        self._reports = reports

    @staticmethod
    def _require_governor(principal: Principal) -> None:
        if not principal.has(MANAGE_PERMISSION):
            raise PermissionDenied("只有治理者能看审计报表")

    async def summary(
        self,
        principal: Principal,
        *,
        since: datetime | None = None,
        until: datetime | None = None,
        user_name: str | None = None,
        task_id: uuid.UUID | None = None,
        bucket: Bucket | None = None,
        timezone: str = "UTC",
    ) -> Summary:
        """全体一格、每人一行、每单一行；给了 ``bucket`` 再按 ``timezone`` 的日 / 周 / 月切一条序列。"""

        self._require_governor(principal)
        scope = _scope(since=since, until=until, user_name=user_name, task_id=task_id)
        series = None
        if bucket is not None:
            series = await self._reports.by_period(
                scope, bucket=bucket, timezone=_check_timezone(timezone)
            )
        return Summary(
            overall=await self._reports.overall(scope),
            users=await self._reports.by_user(scope),
            tasks=await self._reports.by_task(scope),
            series=series,
            attempt_distribution=await self._reports.attempt_distribution(scope),
        )

    async def conversations(
        self,
        principal: Principal,
        *,
        since: datetime | None = None,
        until: datetime | None = None,
        user_name: str | None = None,
        task_id: uuid.UUID | None = None,
        limit: int = 20,
        cursor: str | None = None,
    ) -> ConversationsPage:
        """有成片的对话，最后成片晚的排前面。满页才给下一页游标。"""

        self._require_governor(principal)
        _check_limit(limit)
        scope = _scope(since=since, until=until, user_name=user_name, task_id=task_id)
        items = await self._reports.conversations(
            scope, limit=limit, after=_decode_conversation_cursor(cursor)
        )
        next_cursor = _encode_conversation_cursor(items[-1]) if len(items) == limit else None
        return ConversationsPage(items=items, next_cursor=next_cursor)

    async def anomalies(
        self,
        principal: Principal,
        *,
        since: datetime | None = None,
        until: datetime | None = None,
        user_name: str | None = None,
        task_id: uuid.UUID | None = None,
        kinds: Sequence[AnomalyKind] | None = None,
        thresholds: Thresholds = DEFAULT_THRESHOLDS,
        limit: int = 20,
        cursor: str | None = None,
    ) -> AnomaliesPage:
        """异常按发生时刻倒序。``kinds`` 为空即全部种类。"""

        self._require_governor(principal)
        _check_limit(limit)
        scope = _scope(since=since, until=until, user_name=user_name, task_id=task_id)
        items = await self._reports.anomalies(
            scope,
            thresholds,
            kinds=kinds or None,
            limit=limit,
            after=_decode_anomaly_cursor(cursor),
        )
        next_cursor = _encode_anomaly_cursor(items[-1]) if len(items) == limit else None
        return AnomaliesPage(items=items, next_cursor=next_cursor)


__all__ = [
    "MANAGE_PERMISSION",
    "MAX_LIST_LIMIT",
    "AnomaliesPage",
    "AuditService",
    "ConversationsPage",
    "Summary",
]
