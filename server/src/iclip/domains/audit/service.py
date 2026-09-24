"""审计报表用例：把查询参数整理成筛选范围，负责游标与参数校验。治理者权限由路由声明。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Final, get_args
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from iclip.common.errors import ValidationFailed
from iclip.domains.audit.models import (
    DEFAULT_THRESHOLDS,
    AnomalyCursor,
    AnomalyKind,
    Bucket,
    ConversationCursor,
    Scope,
    Thresholds,
)
from iclip.domains.audit.repository import AuditReports
from iclip.domains.audit.schemas import AnomaliesOut, AuditConversationsOut, SummaryOut
from iclip.platform.paging import BAD_CURSOR, check_limit, decode_cursor, encode_cursor

_ANOMALY_KINDS: Final[frozenset[str]] = frozenset(get_args(AnomalyKind))


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
        raise ValidationFailed(BAD_CURSOR)
    return AnomalyCursor(at=parsed.at, ref=parsed.key)


class AuditService:
    def __init__(self, reports: AuditReports) -> None:
        self._reports = reports

    async def summary(
        self,
        *,
        since: datetime | None = None,
        until: datetime | None = None,
        user_name: str | None = None,
        task_id: uuid.UUID | None = None,
        bucket: Bucket | None = None,
        timezone: str = "UTC",
    ) -> SummaryOut:
        """全体一格、每人一行、每单一行；给了 ``bucket`` 再按 ``timezone`` 的日 / 周 / 月切一条序列。"""

        scope = _scope(since=since, until=until, user_name=user_name, task_id=task_id)
        series = None
        if bucket is not None:
            series = await self._reports.by_period(
                scope, bucket=bucket, timezone=_check_timezone(timezone)
            )
        return SummaryOut(
            overall=await self._reports.overall(scope),
            users=list(await self._reports.by_user(scope)),
            tasks=list(await self._reports.by_task(scope)),
            series=None if series is None else list(series),
            attempt_distribution=list(await self._reports.attempt_distribution(scope)),
            # 总览只要各种异常有几条；阈值按缺省算，与异常页不带参数时同一口径。
            anomaly_counts=list(await self._reports.anomaly_counts(scope, DEFAULT_THRESHOLDS)),
        )

    async def conversations(
        self,
        *,
        since: datetime | None = None,
        until: datetime | None = None,
        user_name: str | None = None,
        task_id: uuid.UUID | None = None,
        limit: int = 20,
        cursor: str | None = None,
    ) -> AuditConversationsOut:
        """有成片的对话，最后成片晚的排前面。满页才给下一页游标。"""

        check_limit(limit)
        scope = _scope(since=since, until=until, user_name=user_name, task_id=task_id)
        items = await self._reports.conversations(
            scope, limit=limit, after=_conversation_after(cursor)
        )
        last = items[-1] if len(items) == limit else None
        next_cursor = (
            None if last is None else encode_cursor(last.delivered_at, last.conversation_id)
        )
        return AuditConversationsOut(items=list(items), next_cursor=next_cursor)

    async def anomalies(
        self,
        *,
        since: datetime | None = None,
        until: datetime | None = None,
        user_name: str | None = None,
        task_id: uuid.UUID | None = None,
        kinds: Sequence[AnomalyKind] | None = None,
        thresholds: Thresholds = DEFAULT_THRESHOLDS,
        limit: int = 20,
        cursor: str | None = None,
    ) -> AnomaliesOut:
        """异常按发生时刻倒序。``kinds`` 为空即全部种类。"""

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
        return AnomaliesOut(items=list(items), next_cursor=next_cursor)


__all__ = ["AuditService"]
