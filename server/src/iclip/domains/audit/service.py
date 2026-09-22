"""审计报表用例：只有治理者能看；把查询参数整理成筛选范围，负责游标与参数校验。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final, get_args
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
from iclip.platform.paging import check_limit, decode_cursor, encode_cursor

MANAGE_PERMISSION: Final = "users:manage"

_ANOMALY_KINDS: Final[frozenset[str]] = frozenset(get_args(AnomalyKind))


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


def _conversation_after(cursor: str | None) -> ConversationCursor | None:
    """把游标还原成对话明细的排序键；``None`` 即从头取。"""

    if cursor is None:
        return None
    parsed = decode_cursor(cursor)
    return ConversationCursor(delivered_at=parsed.at, conversation_id=parsed.uuid_key())


def _anomaly_after(cursor: str | None) -> AnomalyCursor | None:
    """把游标还原成异常的排序键；尾键得是「种类:对象」，种类不认识就不是这个列表发的。"""

    if cursor is None:
        return None
    parsed = decode_cursor(cursor)
    kind, separator, rest = parsed.key.partition(":")
    if not separator or not rest or kind not in _ANOMALY_KINDS:
        raise ValidationFailed("cursor 不是一个有效的翻页位置")
    return AnomalyCursor(at=parsed.at, ref=parsed.key)


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
        check_limit(limit)
        scope = _scope(since=since, until=until, user_name=user_name, task_id=task_id)
        items = await self._reports.conversations(
            scope, limit=limit, after=_conversation_after(cursor)
        )
        last = items[-1] if len(items) == limit else None
        next_cursor = (
            None if last is None else encode_cursor(last.delivered_at, last.conversation_id)
        )
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
        check_limit(limit)
        scope = _scope(since=since, until=until, user_name=user_name, task_id=task_id)
        items = await self._reports.anomalies(
            scope,
            thresholds,
            kinds=kinds or None,
            limit=limit,
            after=_anomaly_after(cursor),
        )
        last = items[-1] if len(items) == limit else None
        next_cursor = None if last is None else encode_cursor(last.at, last.ref)
        return AnomaliesPage(items=items, next_cursor=next_cursor)


__all__ = [
    "MANAGE_PERMISSION",
    "AnomaliesPage",
    "AuditService",
    "ConversationsPage",
    "Summary",
]
