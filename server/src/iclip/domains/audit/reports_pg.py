"""审计报表的 Postgres 查询：跨 ``iclip.*`` 与 ``agent_runtime.*`` 五张表只读聚合，不建表、不写入。

同一份指标 SQL 服务全体、人、需求单、时段、对话五个维度，差别只在四段 CTE 各自的分组键
表达式（``_DIMENSIONS``）——各指标的时间锚点不同，键要在各自的 CTE 里算。键表达式是本文件
的常量，不来自外部输入；外部输入一律走绑定参数。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from iclip.domains.audit.models import (
    EMPTY_METRICS,
    Anomaly,
    AnomalyCursor,
    AnomalyKind,
    Bucket,
    ConversationCursor,
    ConversationReport,
    Metrics,
    ModelUsage,
    PeriodMetrics,
    Scope,
    ShotReport,
    Spread,
    TaskMetrics,
    Thresholds,
    UsageTotals,
    UserMetrics,
)

# ---------------------------------------------------------------------------
# 公共 CTE。videos 是全部口径的基础：只认带数字 metadata.shot 且挂着对话的视频行，
# 需求单从对话取；person 给每段对话定一个人：最近一轮运行的 user_name，没有运行
# 就取最近一条视频的。
# ---------------------------------------------------------------------------

_VIDEOS: Final = """
videos AS (
    SELECT g.id, g.conversation_id, g.status, g.created_at, g.submitted_at, g.finished_at,
           (g.metadata->>'shot')::int AS shot,
           g.request->>'user_name' AS user_name,
           c.task_id
    FROM iclip.generation_jobs g
    JOIN iclip.conversations c ON c.id = g.conversation_id
    WHERE g.kind = 'video' AND jsonb_typeof(g.metadata->'shot') = 'number'
)"""

_PERSON: Final = """
person AS (
    SELECT c.id AS conversation_id, c.title, c.owner_user_id, c.task_id,
           c.created_at, c.updated_at, c.deleted_at,
           COALESCE(
               (SELECT j.user_name FROM agent_runtime.agent_jobs j
                WHERE j.conversation_id = c.id::text
                ORDER BY j.created_at DESC LIMIT 1),
               (SELECT v.user_name FROM videos v
                WHERE v.conversation_id = c.id
                ORDER BY v.created_at DESC, v.id DESC LIMIT 1)
           ) AS user_name
    FROM iclip.conversations c
)"""

_SHOTS: Final = """
shots AS (
    SELECT v.conversation_id, v.shot, v.task_id,
           count(*) AS attempts,
           min(v.created_at) AS first_at,
           max(v.created_at) AS last_at,
           (array_agg(v.status ORDER BY v.created_at, v.id))[1] = 'completed' AS first_pass,
           (array_agg(v.user_name ORDER BY v.created_at, v.id))[1] AS user_name
    FROM videos v
    GROUP BY v.conversation_id, v.shot, v.task_id
)"""

_CYCLES: Final = """
cycles AS (
    SELECT d.conversation_id, p.user_name, p.task_id, d.delivered_at,
           COALESCE(
               (SELECT min(j.created_at) FROM agent_runtime.agent_jobs j
                WHERE j.conversation_id = d.conversation_id::text),
               p.created_at
           ) AS started_at
    FROM (
        SELECT v.conversation_id, max(v.finished_at) AS delivered_at
        FROM videos v
        WHERE v.status = 'completed' AND v.finished_at IS NOT NULL
        GROUP BY v.conversation_id
    ) d
    JOIN person p ON p.conversation_id = d.conversation_id
)"""

_USAGE: Final = """
usage_rows AS (
    SELECT c.id AS conversation_id, p.user_name, p.task_id, u.model_name,
           u.requests, u.input_tokens, u.cache_read_tokens, u.cache_write_tokens,
           u.output_tokens, u.last_at
    FROM agent_runtime.conversation_usage u
    JOIN iclip.conversations c ON c.id::text = u.conversation_id
    JOIN person p ON p.conversation_id = c.id
)"""

# 筛选片段。占位 {t} 是各 CTE 的表别名，{anchor} 是该指标的时间锚点列。
_WINDOW: Final = """
    AND (CAST(:since AS timestamptz) IS NULL OR {anchor} >= CAST(:since AS timestamptz))
    AND (CAST(:until AS timestamptz) IS NULL OR {anchor} < CAST(:until AS timestamptz))"""
_FILTERS: Final = """
    AND (CAST(:user_name AS text) IS NULL OR {t}.user_name = CAST(:user_name AS text))
    AND (CAST(:task_id AS uuid) IS NULL OR {t}.task_id = CAST(:task_id AS uuid))
    AND (CAST(:conversation_ids AS uuid[]) IS NULL
         OR {t}.conversation_id = ANY(CAST(:conversation_ids AS uuid[])))"""


def _spread(expr: str, prefix: str) -> str:
    return f"""
           avg({expr}) AS {prefix}_avg,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY {expr}) AS {prefix}_median,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY {expr}) AS {prefix}_p90"""


_METRICS: Final = f"""
WITH {_VIDEOS}, {_PERSON}, {_SHOTS}, {_CYCLES}, {_USAGE},
completed AS (
    SELECT {{k_video}} AS k,
           count(*) AS completed_videos,
           count(DISTINCT v.task_id) AS delivered_tasks,
           count(DISTINCT v.conversation_id) FILTER (WHERE v.task_id IS NULL)
               AS delivered_orphan_conversations,
           count(DISTINCT v.user_name) AS producers,
           {_spread("extract(epoch FROM v.finished_at - v.created_at)", "video")},
           {_spread("extract(epoch FROM v.finished_at - v.submitted_at)", "upstream")}
    FROM videos v
    WHERE v.status = 'completed' AND v.finished_at IS NOT NULL
    {_WINDOW.format(anchor="v.finished_at")}
    {_FILTERS.format(t="v")}
    GROUP BY 1
),
shot_metrics AS (
    SELECT {{k_shot}} AS k,
           count(*) AS shots,
           sum(s.attempts) AS attempts,
           count(*) FILTER (WHERE s.first_pass) AS first_pass_shots
    FROM shots s
    WHERE TRUE
    {_WINDOW.format(anchor="s.first_at")}
    {_FILTERS.format(t="s")}
    GROUP BY 1
),
cycle_metrics AS (
    SELECT {{k_cycle}} AS k,
           count(*) AS delivered_conversations,
           {_spread("extract(epoch FROM y.delivered_at - y.started_at)", "cycle")}
    FROM cycles y
    WHERE TRUE
    {_WINDOW.format(anchor="y.delivered_at")}
    {_FILTERS.format(t="y")}
    GROUP BY 1
),
usage_metrics AS (
    SELECT {{k_usage}} AS k,
           sum(u.requests) AS requests,
           sum(u.input_tokens) AS input_tokens,
           sum(u.cache_read_tokens) AS cache_read_tokens,
           sum(u.cache_write_tokens) AS cache_write_tokens,
           sum(u.output_tokens) AS output_tokens
    FROM usage_rows u
    WHERE TRUE
    {_WINDOW.format(anchor="u.last_at")}
    {_FILTERS.format(t="u")}
    GROUP BY 1
),
keys AS (
    SELECT k FROM completed UNION SELECT k FROM shot_metrics
    UNION SELECT k FROM cycle_metrics UNION SELECT k FROM usage_metrics
)
SELECT keys.k,
       c.completed_videos, c.delivered_tasks, c.delivered_orphan_conversations, c.producers,
       c.video_avg, c.video_median, c.video_p90,
       c.upstream_avg, c.upstream_median, c.upstream_p90,
       s.shots, s.attempts, s.first_pass_shots,
       y.delivered_conversations, y.cycle_avg, y.cycle_median, y.cycle_p90,
       u.requests, u.input_tokens, u.cache_read_tokens, u.cache_write_tokens, u.output_tokens
FROM keys
LEFT JOIN completed c ON c.k = keys.k
LEFT JOIN shot_metrics s ON s.k = keys.k
LEFT JOIN cycle_metrics y ON y.k = keys.k
LEFT JOIN usage_metrics u ON u.k = keys.k
WHERE keys.k IS NOT NULL
ORDER BY keys.k
"""


@dataclass(frozen=True, slots=True)
class _Dimension:
    """一个维度在四段 CTE 里各自的分组键表达式。"""

    k_video: str
    k_shot: str
    k_cycle: str
    k_usage: str

    def sql(self) -> str:
        return _METRICS.format(
            k_video=self.k_video, k_shot=self.k_shot, k_cycle=self.k_cycle, k_usage=self.k_usage
        )


def _same(column: str) -> _Dimension:
    return _Dimension(f"v.{column}", f"s.{column}", f"y.{column}", f"u.{column}")


_BUCKET: Final = "date_trunc(CAST(:bucket AS text), {anchor}, CAST(:timezone AS text))"

_DIMENSIONS: Final[Mapping[str, _Dimension]] = {
    # 全体用非空常量做键，四段才能按键对上。
    "overall": _Dimension("'all'", "'all'", "'all'", "'all'"),
    "user": _same("user_name"),
    "task": _same("task_id"),
    "conversation": _same("conversation_id"),
    "period": _Dimension(
        _BUCKET.format(anchor="v.finished_at"),
        _BUCKET.format(anchor="s.first_at"),
        _BUCKET.format(anchor="y.delivered_at"),
        _BUCKET.format(anchor="u.last_at"),
    ),
}
_METRICS_SQL: Final = {name: text(dimension.sql()) for name, dimension in _DIMENSIONS.items()}

_TASK_TITLES: Final = text("SELECT id, title FROM iclip.tasks WHERE id = ANY(CAST(:ids AS uuid[]))")

_CONVERSATIONS: Final = text(f"""
WITH {_VIDEOS}, {_PERSON}, {_CYCLES}
SELECT y.conversation_id, y.user_name, y.task_id, y.started_at, y.delivered_at,
       p.title, p.owner_user_id, p.deleted_at
FROM cycles y
JOIN person p ON p.conversation_id = y.conversation_id
WHERE TRUE
{_WINDOW.format(anchor="y.delivered_at")}
{_FILTERS.format(t="y")}
  AND (CAST(:after_at AS timestamptz) IS NULL
       OR (y.delivered_at, y.conversation_id) < (CAST(:after_at AS timestamptz), CAST(:after_id AS uuid)))
ORDER BY y.delivered_at DESC, y.conversation_id DESC
LIMIT :limit
""")

_SHOTS_OF: Final = text(f"""
WITH {_VIDEOS}, {_SHOTS}
SELECT s.conversation_id, s.shot, s.attempts, s.first_pass, s.first_at, s.last_at
FROM shots s
WHERE s.conversation_id = ANY(CAST(:ids AS uuid[]))
ORDER BY s.conversation_id, s.shot
""")

_USAGE_OF: Final = text("""
SELECT c.id AS conversation_id, u.model_name, u.requests, u.input_tokens,
       u.cache_read_tokens, u.cache_write_tokens, u.output_tokens
FROM agent_runtime.conversation_usage u
JOIN iclip.conversations c ON c.id::text = u.conversation_id
WHERE c.id = ANY(CAST(:ids AS uuid[]))
ORDER BY c.id, u.model_name
""")

# ---------------------------------------------------------------------------
# 异常。每种一段 CTE，列一致后 UNION ALL，再按（时刻，ref）倒序翻页。
# slow / spend 的门槛按筛选范围现算 P90 / P95，范围小时门槛会抖。
# ---------------------------------------------------------------------------

_ANOMALY_COLUMNS: Final = (
    "kind, at, ref, value, threshold, conversation_id, task_id, user_name, shot, generation_id"
)

_ANOMALIES: Final = text(f"""
WITH {_VIDEOS}, {_PERSON}, {_SHOTS}, {_CYCLES}, {_USAGE},
windowed_cycles AS (
    SELECT y.* FROM cycles y
    WHERE TRUE
    {_WINDOW.format(anchor="y.delivered_at")}
    {_FILTERS.format(t="y")}
),
cycle_p90 AS (
    SELECT percentile_cont(0.9) WITHIN GROUP (
        ORDER BY extract(epoch FROM y.delivered_at - y.started_at)) AS threshold
    FROM windowed_cycles y
),
spend AS (
    SELECT u.conversation_id, u.user_name, u.task_id,
           sum(u.input_tokens + u.cache_read_tokens + u.cache_write_tokens + u.output_tokens)
               AS total_tokens,
           max(u.last_at) AS last_at
    FROM usage_rows u
    WHERE TRUE
    {_FILTERS.format(t="u")}
    GROUP BY u.conversation_id, u.user_name, u.task_id
),
windowed_spend AS (
    SELECT z.* FROM spend z
    WHERE TRUE
    {_WINDOW.format(anchor="z.last_at")}
),
spend_p95 AS (
    SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY z.total_tokens) AS threshold
    FROM windowed_spend z
),
retry AS (
    SELECT 'retry' AS kind, s.last_at AS at,
           'retry:' || s.conversation_id || ':' || s.shot AS ref,
           s.attempts::float8 AS value, CAST(:retry_over AS int)::float8 AS threshold,
           s.conversation_id, s.task_id, s.user_name, s.shot, NULL::uuid AS generation_id
    FROM shots s
    WHERE s.attempts > CAST(:retry_over AS int)
    {_WINDOW.format(anchor="s.last_at")}
    {_FILTERS.format(t="s")}
),
idle AS (
    SELECT 'idle', p.updated_at, 'idle:' || p.conversation_id,
           extract(epoch FROM now() - p.updated_at) / 3600, CAST(:idle_hours AS int)::float8,
           p.conversation_id, p.task_id, p.user_name, NULL::int, NULL::uuid
    FROM person p
    WHERE p.deleted_at IS NULL
      AND p.updated_at < now() - CAST(:idle_hours AS int) * interval '1 hour'
      AND EXISTS (SELECT 1 FROM agent_runtime.agent_jobs j WHERE j.conversation_id = p.conversation_id::text)
      AND NOT EXISTS (SELECT 1 FROM cycles y WHERE y.conversation_id = p.conversation_id)
    {_WINDOW.format(anchor="p.updated_at")}
    {_FILTERS.format(t="p")}
),
slow AS (
    SELECT 'slow', y.delivered_at, 'slow:' || y.conversation_id,
           extract(epoch FROM y.delivered_at - y.started_at), t.threshold,
           y.conversation_id, y.task_id, y.user_name, NULL::int, NULL::uuid
    FROM windowed_cycles y, cycle_p90 t
    WHERE extract(epoch FROM y.delivered_at - y.started_at) > t.threshold
),
stuck AS (
    SELECT 'stuck', v.submitted_at, 'stuck:' || v.id,
           extract(epoch FROM now() - v.submitted_at) / 3600, CAST(:stuck_hours AS int)::float8,
           v.conversation_id, v.task_id, v.user_name, v.shot, v.id
    FROM videos v
    WHERE v.status = 'submitted'
      AND v.submitted_at < now() - CAST(:stuck_hours AS int) * interval '1 hour'
    {_WINDOW.format(anchor="v.submitted_at")}
    {_FILTERS.format(t="v")}
),
overspend AS (
    SELECT 'spend', z.last_at, 'spend:' || z.conversation_id,
           z.total_tokens::float8, t.threshold,
           z.conversation_id, z.task_id, z.user_name, NULL::int, NULL::uuid
    FROM windowed_spend z, spend_p95 t
    WHERE z.total_tokens > t.threshold
),
task_stuck AS (
    SELECT 'task_stuck', max(p.updated_at), 'task_stuck:' || p.task_id,
           count(*)::float8, CAST(:task_conversations AS int)::float8,
           NULL::uuid, p.task_id, NULL::text, NULL::int, NULL::uuid
    FROM person p
    WHERE p.task_id IS NOT NULL
      AND (CAST(:task_id AS uuid) IS NULL OR p.task_id = CAST(:task_id AS uuid))
      AND (CAST(:conversation_ids AS uuid[]) IS NULL)
      AND NOT EXISTS (
          SELECT 1 FROM cycles y JOIN person q ON q.conversation_id = y.conversation_id
          WHERE q.task_id = p.task_id)
    GROUP BY p.task_id
    HAVING count(*) >= CAST(:task_conversations AS int)
       AND (CAST(:user_name AS text) IS NULL OR bool_or(p.user_name = CAST(:user_name AS text)))
       AND (CAST(:since AS timestamptz) IS NULL OR max(p.updated_at) >= CAST(:since AS timestamptz))
       AND (CAST(:until AS timestamptz) IS NULL OR max(p.updated_at) < CAST(:until AS timestamptz))
),
deleted AS (
    SELECT 'deleted', p.deleted_at, 'deleted:' || p.conversation_id,
           (SELECT count(*) FROM videos v
            WHERE v.conversation_id = p.conversation_id AND v.status = 'completed')::float8,
           NULL::float8,
           p.conversation_id, p.task_id, p.user_name, NULL::int, NULL::uuid
    FROM person p
    WHERE p.deleted_at IS NOT NULL
    {_WINDOW.format(anchor="p.deleted_at")}
    {_FILTERS.format(t="p")}
),
no_task AS (
    SELECT 'no_task', y.delivered_at, 'no_task:' || y.conversation_id,
           (SELECT count(*) FROM videos v
            WHERE v.conversation_id = y.conversation_id AND v.status = 'completed')::float8,
           NULL::float8,
           y.conversation_id, NULL::uuid, y.user_name, NULL::int, NULL::uuid
    FROM windowed_cycles y
    WHERE y.task_id IS NULL
),
missing_shot AS (
    SELECT 'missing_shot', g.created_at, 'missing_shot:' || g.id,
           NULL::float8, NULL::float8,
           g.conversation_id, c.task_id, g.request->>'user_name', NULL::int, g.id
    FROM iclip.generation_jobs g
    LEFT JOIN iclip.conversations c ON c.id = g.conversation_id
    WHERE g.kind = 'video' AND jsonb_typeof(g.metadata->'shot') IS DISTINCT FROM 'number'
    {_WINDOW.format(anchor="g.created_at")}
      AND (CAST(:user_name AS text) IS NULL OR g.request->>'user_name' = CAST(:user_name AS text))
      AND (CAST(:task_id AS uuid) IS NULL OR c.task_id = CAST(:task_id AS uuid))
      AND (CAST(:conversation_ids AS uuid[]) IS NULL
           OR g.conversation_id = ANY(CAST(:conversation_ids AS uuid[])))
),
everything ({_ANOMALY_COLUMNS}) AS (
    SELECT * FROM retry UNION ALL SELECT * FROM idle UNION ALL SELECT * FROM slow
    UNION ALL SELECT * FROM stuck UNION ALL SELECT * FROM overspend
    UNION ALL SELECT * FROM task_stuck UNION ALL SELECT * FROM deleted
    UNION ALL SELECT * FROM no_task UNION ALL SELECT * FROM missing_shot
)
SELECT {_ANOMALY_COLUMNS}
FROM everything
WHERE (CAST(:kinds AS text[]) IS NULL OR kind = ANY(CAST(:kinds AS text[])))
  AND (CAST(:after_at AS timestamptz) IS NULL
       OR (at, ref) < (CAST(:after_at AS timestamptz), CAST(:after_ref AS text)))
ORDER BY at DESC, ref DESC
LIMIT :limit
""")


def _scope_params(
    scope: Scope, *, conversation_ids: Sequence[uuid.UUID] | None = None
) -> dict[str, Any]:
    return {
        "since": scope.since,
        "until": scope.until,
        "user_name": scope.user_name,
        "task_id": scope.task_id,
        "conversation_ids": list(conversation_ids) if conversation_ids is not None else None,
    }


def _float(value: Any) -> float | None:
    """聚合列可能是 numeric / Decimal，也可能因为没有样本而是 NULL。"""

    return None if value is None else float(value)


def _int(value: Any) -> int:
    """LEFT JOIN 没对上的计数列是 NULL，按 0 读。"""

    return 0 if value is None else int(value)


def _spread_of(row: RowMapping, prefix: str) -> Spread | None:
    avg, median, p90 = (_float(row[f"{prefix}_{name}"]) for name in ("avg", "median", "p90"))
    if avg is None or median is None or p90 is None:
        return None
    return Spread(avg=avg, median=median, p90=p90)


def _usage_of(row: RowMapping) -> UsageTotals:
    return UsageTotals(
        requests=_int(row["requests"]),
        input_tokens=_int(row["input_tokens"]),
        cache_read_tokens=_int(row["cache_read_tokens"]),
        cache_write_tokens=_int(row["cache_write_tokens"]),
        output_tokens=_int(row["output_tokens"]),
    )


def _metrics_of(row: RowMapping) -> Metrics:
    return Metrics(
        completed_videos=_int(row["completed_videos"]),
        delivered_tasks=_int(row["delivered_tasks"]),
        delivered_orphan_conversations=_int(row["delivered_orphan_conversations"]),
        producers=_int(row["producers"]),
        shots=_int(row["shots"]),
        attempts=_int(row["attempts"]),
        first_pass_shots=_int(row["first_pass_shots"]),
        delivered_conversations=_int(row["delivered_conversations"]),
        cycle_seconds=_spread_of(row, "cycle"),
        video_seconds=_spread_of(row, "video"),
        upstream_seconds=_spread_of(row, "upstream"),
        usage=_usage_of(row),
    )


def _rank(metrics: Metrics) -> tuple[int, int]:
    """人与需求单的排序：成片件数多的在前，再看成片视频条数。"""

    return (-metrics.deliveries, -metrics.completed_videos)


class PgAuditReports:
    """``AuditReports`` 的 Postgres 实现。每个方法一个连接、只读。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def _metrics(
        self, dimension: str, params: dict[str, Any], *, conn: AsyncConnection | None = None
    ) -> Sequence[RowMapping]:
        statement = _METRICS_SQL[dimension]
        if conn is not None:
            return (await conn.execute(statement, params)).mappings().all()
        async with self._engine.connect() as fresh:
            return (await fresh.execute(statement, params)).mappings().all()

    async def overall(self, scope: Scope) -> Metrics:
        rows = await self._metrics("overall", _scope_params(scope))
        return _metrics_of(rows[0]) if rows else EMPTY_METRICS

    async def by_user(self, scope: Scope) -> Sequence[UserMetrics]:
        rows = await self._metrics("user", _scope_params(scope))
        found = [UserMetrics(user_name=str(row["k"]), metrics=_metrics_of(row)) for row in rows]
        return sorted(found, key=lambda item: (_rank(item.metrics), item.user_name))

    async def by_task(self, scope: Scope) -> Sequence[TaskMetrics]:
        async with self._engine.connect() as conn:
            rows = await self._metrics("task", _scope_params(scope), conn=conn)
            ids = [row["k"] for row in rows]
            titles = (
                {
                    title_row["id"]: title_row["title"]
                    for title_row in (await conn.execute(_TASK_TITLES, {"ids": ids})).mappings()
                }
                if ids
                else {}
            )
        found = [
            TaskMetrics(task_id=row["k"], title=titles.get(row["k"], ""), metrics=_metrics_of(row))
            for row in rows
        ]
        return sorted(found, key=lambda item: (_rank(item.metrics), str(item.task_id)))

    async def by_period(
        self, scope: Scope, *, bucket: Bucket, timezone: str
    ) -> Sequence[PeriodMetrics]:
        params = {**_scope_params(scope), "bucket": bucket, "timezone": timezone}
        rows = await self._metrics("period", params)
        return [PeriodMetrics(period_start=row["k"], metrics=_metrics_of(row)) for row in rows]

    async def conversations(
        self, scope: Scope, *, limit: int, after: ConversationCursor | None
    ) -> Sequence[ConversationReport]:
        params = {
            **_scope_params(scope),
            "after_at": after.delivered_at if after else None,
            "after_id": after.conversation_id if after else None,
            "limit": limit,
        }
        async with self._engine.connect() as conn:
            heads = (await conn.execute(_CONVERSATIONS, params)).mappings().all()
            if not heads:
                return []
            ids = [head["conversation_id"] for head in heads]
            # 对话行的指标是全量，不带时间窗；用维度键圈定这一页的对话即可。
            metric_rows = await self._metrics(
                "conversation", _scope_params(Scope(), conversation_ids=ids), conn=conn
            )
            shot_rows = (await conn.execute(_SHOTS_OF, {"ids": ids})).mappings().all()
            usage_rows = (await conn.execute(_USAGE_OF, {"ids": ids})).mappings().all()

        metrics = {row["k"]: _metrics_of(row) for row in metric_rows}
        shots: dict[uuid.UUID, list[ShotReport]] = {}
        for row in shot_rows:
            shots.setdefault(row["conversation_id"], []).append(
                ShotReport(
                    shot=int(row["shot"]),
                    attempts=int(row["attempts"]),
                    first_pass=bool(row["first_pass"]),
                    first_at=row["first_at"],
                    last_at=row["last_at"],
                )
            )
        usage: dict[uuid.UUID, list[ModelUsage]] = {}
        for row in usage_rows:
            usage.setdefault(row["conversation_id"], []).append(
                ModelUsage(model_name=row["model_name"], usage=_usage_of(row))
            )
        return [
            ConversationReport(
                conversation_id=head["conversation_id"],
                title=head["title"],
                owner_user_id=head["owner_user_id"],
                user_name=head["user_name"],
                task_id=head["task_id"],
                deleted_at=head["deleted_at"],
                started_at=head["started_at"],
                delivered_at=head["delivered_at"],
                metrics=metrics.get(head["conversation_id"], EMPTY_METRICS),
                shots=tuple(shots.get(head["conversation_id"], ())),
                usage=tuple(usage.get(head["conversation_id"], ())),
            )
            for head in heads
        ]

    async def anomalies(
        self,
        scope: Scope,
        thresholds: Thresholds,
        *,
        kinds: Sequence[AnomalyKind] | None,
        limit: int,
        after: AnomalyCursor | None,
    ) -> Sequence[Anomaly]:
        params = {
            **_scope_params(scope),
            "retry_over": thresholds.retry_over,
            "idle_hours": thresholds.idle_hours,
            "stuck_hours": thresholds.stuck_hours,
            "task_conversations": thresholds.task_conversations,
            "kinds": list(kinds) if kinds is not None else None,
            "after_at": after.at if after else None,
            "after_ref": after.ref if after else None,
            "limit": limit,
        }
        async with self._engine.connect() as conn:
            rows = (await conn.execute(_ANOMALIES, params)).mappings().all()
        return [
            Anomaly(
                kind=row["kind"],
                at=row["at"],
                ref=row["ref"],
                value=_float(row["value"]),
                threshold=_float(row["threshold"]),
                conversation_id=row["conversation_id"],
                task_id=row["task_id"],
                user_name=row["user_name"],
                shot=None if row["shot"] is None else int(row["shot"]),
                generation_id=row["generation_id"],
            )
            for row in rows
        ]


__all__ = ["PgAuditReports"]
