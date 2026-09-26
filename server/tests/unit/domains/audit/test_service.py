"""审计用例层：参数校验、游标往返，以及领域模型上派生比率的口径。不连库。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from iclip.common.errors import ValidationFailed
from iclip.domains.audit.models import (
    AnomalyCursor,
    AnomalyKind,
    Bucket,
    ConversationCursor,
    Scope,
    Thresholds,
)
from iclip.domains.audit.schemas import (
    EMPTY_METRICS,
    AnomalyCountOut,
    AnomalyOut,
    AttemptBucketOut,
    ConversationAuditOut,
    MetricsOut,
    PeriodMetricsOut,
    SpreadOut,
    TaskMetricsOut,
    UsageOut,
    UserMetricsOut,
)
from iclip.domains.audit.service import AuditService

NOW = datetime(2026, 9, 15, 12, 0, tzinfo=UTC)


def report(conversation_id: uuid.UUID, delivered_at: datetime) -> ConversationAuditOut:
    return ConversationAuditOut(
        conversation_id=conversation_id,
        title="t",
        owner_user_id=uuid.uuid4(),
        user_name="Shan.Hu",
        task_id=None,
        deleted_at=None,
        started_at=delivered_at - timedelta(hours=1),
        delivered_at=delivered_at,
        metrics=EMPTY_METRICS,
        shots=[],
        usage=[],
    )


def anomaly(kind: AnomalyKind, at: datetime, ref: str) -> AnomalyOut:
    return AnomalyOut(
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


ATTEMPT_ROWS: Sequence[AttemptBucketOut] = (
    AttemptBucketOut(attempts=1, shots=62),
    AttemptBucketOut(attempts=2, shots=24),
    AttemptBucketOut(attempts=5, shots=2),
)

ANOMALY_COUNT_ROWS: Sequence[AnomalyCountOut] = (
    AnomalyCountOut(kind="retry", count=3),
    AnomalyCountOut(kind="idle", count=1),
)


@dataclass
class RecordingReports:
    """记下每次调用的参数，按需要回放固定结果。"""

    conversation_rows: list[ConversationAuditOut] = field(default_factory=list)
    anomaly_rows: list[AnomalyOut] = field(default_factory=list)
    calls: list[tuple[str, Any]] = field(default_factory=list)

    async def overall(self, scope: Scope) -> MetricsOut:
        self.calls.append(("overall", scope))
        return EMPTY_METRICS

    async def by_user(self, scope: Scope) -> Sequence[UserMetricsOut]:
        self.calls.append(("by_user", scope))
        return []

    async def by_task(self, scope: Scope) -> Sequence[TaskMetricsOut]:
        self.calls.append(("by_task", scope))
        return []

    async def by_period(
        self, scope: Scope, *, bucket: Bucket, timezone: str
    ) -> Sequence[PeriodMetricsOut]:
        self.calls.append(("by_period", (scope, bucket, timezone)))
        return []

    async def attempt_distribution(self, scope: Scope) -> Sequence[AttemptBucketOut]:
        self.calls.append(("attempt_distribution", scope))
        return ATTEMPT_ROWS

    async def conversations(
        self, scope: Scope, *, limit: int, after: ConversationCursor | None
    ) -> Sequence[ConversationAuditOut]:
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
    ) -> Sequence[AnomalyOut]:
        self.calls.append(("anomalies", (scope, thresholds, kinds, after)))
        return self.anomaly_rows[:limit]

    async def anomaly_counts(
        self, scope: Scope, thresholds: Thresholds
    ) -> Sequence[AnomalyCountOut]:
        self.calls.append(("anomaly_counts", (scope, thresholds)))
        return ANOMALY_COUNT_ROWS


async def test_summary_normalises_the_window_and_only_buckets_on_request() -> None:
    reports = RecordingReports()
    service = AuditService(reports)

    plain = await service.summary(since=datetime(2026, 9, 1), until=datetime(2026, 9, 2))
    bucketed = await service.summary(bucket="day", timezone="Asia/Shanghai")

    assert plain.series is None and bucketed.series == []
    assert plain.attempt_distribution == list(ATTEMPT_ROWS)
    assert ("attempt_distribution", Scope()) in reports.calls
    # 异常计数跟着汇总走，阈值取缺省，与异常页不带参数时一致。
    assert plain.anomaly_counts == list(ANOMALY_COUNT_ROWS)
    assert ("anomaly_counts", (Scope(), Thresholds())) in reports.calls
    scopes = [scope for name, scope in reports.calls if name == "overall"]
    assert scopes[0] == Scope(
        since=datetime(2026, 9, 1, tzinfo=UTC), until=datetime(2026, 9, 2, tzinfo=UTC)
    )
    assert ("by_period", (Scope(), "day", "Asia/Shanghai")) in reports.calls
    assert sum(1 for name, _ in reports.calls if name == "by_period") == 1


async def test_inverted_window_and_unknown_timezone_are_rejected() -> None:
    service = AuditService(RecordingReports())

    with pytest.raises(ValidationFailed, match="since"):
        await service.summary(since=NOW, until=NOW)
    with pytest.raises(ValidationFailed, match="timezone"):
        await service.summary(bucket="day", timezone="Mars/Olympus")


async def test_conversation_cursor_round_trips_and_only_appears_on_a_full_page() -> None:
    ids = [uuid.uuid4() for _ in range(3)]
    reports = RecordingReports(
        conversation_rows=[report(ids[i], NOW - timedelta(hours=i)) for i in range(3)]
    )
    service = AuditService(reports)

    full = await service.conversations(limit=2)
    short = await service.conversations(limit=4)
    assert full.next_cursor is not None and short.next_cursor is None

    await service.conversations(limit=2, cursor=full.next_cursor)
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

    page = await service.anomalies(limit=1, kinds=["retry"])
    assert page.next_cursor is not None

    await service.anomalies(limit=1, cursor=page.next_cursor)
    _, (_, _, kinds, after) = reports.calls[-1]
    assert after == AnomalyCursor(at=NOW, ref=reports.anomaly_rows[0].ref)
    assert kinds is None, "不给 kinds 就是全部，不能把上一页的筛选带过来"


async def test_malformed_cursors_are_422() -> None:
    """尾键形状合法、只有时间戳坏：两条列表都得把解码失败原样抛出来。"""

    service = AuditService(RecordingReports())

    with pytest.raises(ValidationFailed, match="cursor"):
        await service.conversations(cursor=f"not-a-date|{uuid.uuid4()}")
    with pytest.raises(ValidationFailed, match="cursor"):
        await service.anomalies(cursor="not-a-date|retry:x")


@pytest.mark.parametrize("ref", ["fabricated:x", "retry", "retry:"])
async def test_anomaly_cursor_rejects_a_ref_this_list_never_issued(ref: str) -> None:
    """异常游标的尾键得是「种类:对象」，种类还得是认识的那几种。"""

    service = AuditService(RecordingReports())

    with pytest.raises(ValidationFailed, match="cursor"):
        await service.anomalies(cursor=f"{NOW.isoformat()}|{ref}")


async def test_limit_out_of_range_is_422() -> None:
    service = AuditService(RecordingReports())

    with pytest.raises(ValidationFailed, match="limit"):
        await service.conversations(limit=0)
    with pytest.raises(ValidationFailed, match="limit"):
        await service.anomalies(limit=101)


def test_metrics_derive_ratios_and_go_blank_on_zero_denominators() -> None:
    usage = UsageOut(
        requests=3,
        input_tokens=100,
        cache_read_tokens=300,
        cache_write_tokens=100,
        output_tokens=50,
    )
    metrics = MetricsOut(
        completed_videos=4,
        delivered_tasks=1,
        delivered_orphan_conversations=1,
        producers=2,
        shots=4,
        attempts=6,
        one_take_shots=3,
        delivered_shots=3,
        effective_shots=2,
        runs=5,
        delivered_conversations=2,
        cycle_seconds=SpreadOut(avg=1, median=1, p90=1),
        video_seconds=None,
        upstream_seconds=None,
        usage=usage,
    )

    assert metrics.deliveries == 2
    assert metrics.attempts_per_shot == 1.5
    assert metrics.one_take_rate == 0.75
    assert metrics.effective_rate == pytest.approx(2 / 3)
    assert usage.total_tokens == 550
    assert usage.cache_hit_rate == 0.6
    assert metrics.tokens_per_delivery == 275
    assert EMPTY_METRICS.attempts_per_shot is None
    assert EMPTY_METRICS.one_take_rate is None
    assert EMPTY_METRICS.effective_rate is None
    assert EMPTY_METRICS.tokens_per_delivery is None
    assert EMPTY_METRICS.usage.cache_hit_rate is None
