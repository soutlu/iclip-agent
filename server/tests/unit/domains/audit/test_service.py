"""审计用例层：鉴权、参数校验、游标往返，以及领域模型上派生比率的口径。不连库。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from iclip.common.errors import PermissionDenied, ValidationFailed
from iclip.domains.audit.models import (
    EMPTY_METRICS,
    Anomaly,
    AnomalyCursor,
    AnomalyKind,
    Bucket,
    ConversationCursor,
    ConversationReport,
    Metrics,
    PeriodMetrics,
    Scope,
    Spread,
    TaskMetrics,
    Thresholds,
    UsageTotals,
    UserMetrics,
)
from iclip.domains.audit.service import AuditService
from iclip.domains.identity.public import Principal

NOW = datetime(2026, 9, 15, 12, 0, tzinfo=UTC)


def principal(*permissions: str) -> Principal:
    return Principal(
        kind="user", user_id=uuid.uuid4(), permissions=frozenset(permissions), audit_label="tester"
    )


GOVERNOR = principal("users:manage", "agent:read")
EDITOR = principal("agent:read", "generation:read")


def report(conversation_id: uuid.UUID, delivered_at: datetime) -> ConversationReport:
    return ConversationReport(
        conversation_id=conversation_id,
        title="t",
        owner_user_id=uuid.uuid4(),
        user_name="Shan.Hu",
        task_id=None,
        deleted_at=None,
        started_at=delivered_at - timedelta(hours=1),
        delivered_at=delivered_at,
        metrics=EMPTY_METRICS,
        shots=(),
        usage=(),
    )


def anomaly(kind: AnomalyKind, at: datetime, ref: str) -> Anomaly:
    return Anomaly(
        kind=kind,
        at=at,
        ref=ref,
        value=1.0,
        threshold=None,
        conversation_id=None,
        task_id=None,
        user_name=None,
        shot=None,
        generation_id=None,
    )


@dataclass
class RecordingReports:
    """记下每次调用的参数，按需要回放固定结果。"""

    conversation_rows: list[ConversationReport] = field(default_factory=list)
    anomaly_rows: list[Anomaly] = field(default_factory=list)
    calls: list[tuple[str, Any]] = field(default_factory=list)

    async def overall(self, scope: Scope) -> Metrics:
        self.calls.append(("overall", scope))
        return EMPTY_METRICS

    async def by_user(self, scope: Scope) -> Sequence[UserMetrics]:
        self.calls.append(("by_user", scope))
        return []

    async def by_task(self, scope: Scope) -> Sequence[TaskMetrics]:
        self.calls.append(("by_task", scope))
        return []

    async def by_period(
        self, scope: Scope, *, bucket: Bucket, timezone: str
    ) -> Sequence[PeriodMetrics]:
        self.calls.append(("by_period", (scope, bucket, timezone)))
        return []

    async def conversations(
        self, scope: Scope, *, limit: int, after: ConversationCursor | None
    ) -> Sequence[ConversationReport]:
        self.calls.append(("conversations", (scope, limit, after)))
        return self.conversation_rows[:limit]

    async def anomalies(
        self,
        scope: Scope,
        thresholds: Thresholds,
        *,
        kinds: Sequence[AnomalyKind] | None,
        limit: int,
        after: AnomalyCursor | None,
    ) -> Sequence[Anomaly]:
        self.calls.append(("anomalies", (scope, thresholds, kinds, after)))
        return self.anomaly_rows[:limit]


async def test_only_governors_may_read() -> None:
    service = AuditService(RecordingReports())

    for call in (service.summary, service.conversations, service.anomalies):
        with pytest.raises(PermissionDenied):
            await call(EDITOR)


async def test_summary_normalises_the_window_and_only_buckets_on_request() -> None:
    reports = RecordingReports()
    service = AuditService(reports)

    plain = await service.summary(GOVERNOR, since=datetime(2026, 9, 1), until=datetime(2026, 9, 2))
    bucketed = await service.summary(GOVERNOR, bucket="day", timezone="Asia/Shanghai")

    assert plain.series is None and bucketed.series == []
    scopes = [scope for name, scope in reports.calls if name == "overall"]
    assert scopes[0] == Scope(
        since=datetime(2026, 9, 1, tzinfo=UTC), until=datetime(2026, 9, 2, tzinfo=UTC)
    )
    assert ("by_period", (Scope(), "day", "Asia/Shanghai")) in reports.calls
    assert sum(1 for name, _ in reports.calls if name == "by_period") == 1


async def test_inverted_window_and_unknown_timezone_are_rejected() -> None:
    service = AuditService(RecordingReports())

    with pytest.raises(ValidationFailed, match="since"):
        await service.summary(GOVERNOR, since=NOW, until=NOW)
    with pytest.raises(ValidationFailed, match="timezone"):
        await service.summary(GOVERNOR, bucket="day", timezone="Mars/Olympus")


async def test_conversation_cursor_round_trips_and_only_appears_on_a_full_page() -> None:
    ids = [uuid.uuid4() for _ in range(3)]
    reports = RecordingReports(
        conversation_rows=[report(ids[i], NOW - timedelta(hours=i)) for i in range(3)]
    )
    service = AuditService(reports)

    full = await service.conversations(GOVERNOR, limit=2)
    short = await service.conversations(GOVERNOR, limit=4)
    assert full.next_cursor is not None and short.next_cursor is None

    await service.conversations(GOVERNOR, limit=2, cursor=full.next_cursor)
    _, (_, _, after) = reports.calls[-1]
    assert after == ConversationCursor(
        delivered_at=NOW - timedelta(hours=1), conversation_id=ids[1]
    )


async def test_anomaly_cursor_keeps_a_ref_with_colons() -> None:
    reports = RecordingReports(
        anomaly_rows=[
            anomaly("retry", NOW, f"retry:{uuid.uuid4()}:2"),
            anomaly("idle", NOW, "idle:x"),
        ]
    )
    service = AuditService(reports)

    page = await service.anomalies(GOVERNOR, limit=1, kinds=["retry"])
    assert page.next_cursor is not None

    await service.anomalies(GOVERNOR, limit=1, cursor=page.next_cursor)
    _, (_, _, kinds, after) = reports.calls[-1]
    assert after == AnomalyCursor(at=NOW, ref=reports.anomaly_rows[0].ref)
    assert kinds is None, "不给 kinds 就是全部，不能把上一页的筛选带过来"


@pytest.mark.parametrize("cursor", ["nonsense", "2026-09-15T12:00:00+00:00|", "not-a-date|x"])
async def test_malformed_cursors_are_422(cursor: str) -> None:
    service = AuditService(RecordingReports())

    with pytest.raises(ValidationFailed, match="cursor"):
        await service.conversations(GOVERNOR, cursor=cursor)
    with pytest.raises(ValidationFailed, match="cursor"):
        await service.anomalies(GOVERNOR, cursor=cursor)


async def test_limit_out_of_range_is_422() -> None:
    service = AuditService(RecordingReports())

    with pytest.raises(ValidationFailed, match="limit"):
        await service.conversations(GOVERNOR, limit=0)
    with pytest.raises(ValidationFailed, match="limit"):
        await service.anomalies(GOVERNOR, limit=101)


def test_metrics_derive_ratios_and_go_blank_on_zero_denominators() -> None:
    usage = UsageTotals(
        requests=3,
        input_tokens=100,
        cache_read_tokens=300,
        cache_write_tokens=100,
        output_tokens=50,
    )
    metrics = Metrics(
        completed_videos=4,
        delivered_tasks=1,
        delivered_orphan_conversations=1,
        producers=2,
        shots=4,
        attempts=6,
        first_pass_shots=3,
        delivered_conversations=2,
        cycle_seconds=Spread(avg=1, median=1, p90=1),
        video_seconds=None,
        upstream_seconds=None,
        usage=usage,
    )

    assert metrics.deliveries == 2
    assert metrics.attempts_per_shot == 1.5
    assert metrics.first_pass_rate == 0.75
    assert usage.total_tokens == 550
    assert usage.cache_hit_rate == 0.6
    assert metrics.tokens_per_delivery == 275
    assert EMPTY_METRICS.attempts_per_shot is None
    assert EMPTY_METRICS.first_pass_rate is None
    assert EMPTY_METRICS.tokens_per_delivery is None
    assert EMPTY_METRICS.usage.cache_hit_rate is None
