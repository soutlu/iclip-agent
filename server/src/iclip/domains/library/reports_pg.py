"""资料库的 Postgres 查询：跨生成记录、对话、用户三张表只读，不建表、不写入。

SQL 里的 'video' / 'clip' / 'completed' 镜像生成域的 KIND_VIDEO / KIND_CLIP / STATUS_COMPLETED，
'master' 镜像 ClipPurpose 的取值（按表名直接查，不 import 业务模块）；集成测试的种子取自那些
常量，生成域改词这里的用例就红。外部输入一律走绑定参数。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Any, Final

from pydantic import BaseModel, ConfigDict
from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.common.shot_prompt import parse_shot_prompt
from iclip.domains.library.models import Scope, VideoCursor
from iclip.domains.library.repository import CardRow
from iclip.domains.library.schemas import (
    FaceOut,
    LibraryAuthorOut,
    LibraryVideoOut,
    MasterOut,
    ScriptCutOut,
    ScriptOut,
    TakeOut,
)

# ---------------------------------------------------------------------------
# 收录口径，一段 CTE 供所有查询共用：
# roots  成功的独立视频记录，已删对话里的不收；
# takes  每条都是一次出片；镜的身份是（对话，镜号），没有镜号或不挂对话的一条自成一镜；
# masters 成片按原作号挂到那次出片上：分叉副本里剪继承来的出片，成片也挂在源那一镜；
#        成片所在的对话删了就不收；
# master_lists 每次出片名下的全部成片与最新那条，一次分组算完，不逐行子查询；
# faces  每次出片带上名下成片与画幅朝向；
# cards  一镜一张卡，卡面取这一镜最新的成片，没有成片就取最新一次出片。
# ---------------------------------------------------------------------------

_BASE: Final = r"""
WITH roots AS (
    SELECT g.id, g.request, g.output_url, g.watermark_output_url, g.created_at,
           COALESCE(NULLIF(g.request->>'user_name', ''), u.username) AS user_name,
           c.id AS conversation_id, c.owner_user_id AS conversation_owner, c.title,
           c.agent_id, c.task_id,
           CASE WHEN c.id IS NOT NULL AND jsonb_typeof(g.metadata->'shot') = 'number'
                THEN (g.metadata->>'shot')::int END AS shot_index
    FROM iclip.generation_jobs g
    JOIN iclip.users u ON u.id = g.owner_user_id
    LEFT JOIN iclip.conversations c ON c.id = g.conversation_id
    WHERE g.kind = 'video' AND g.root_job_id IS NULL AND g.status = 'completed'
      AND g.output_url IS NOT NULL AND c.deleted_at IS NULL
),
takes AS (
    SELECT r.*,
           CASE WHEN r.shot_index IS NULL THEN r.id::text
                ELSE r.conversation_id::text || '#' || r.shot_index END AS shot_key
    FROM roots r
),
masters AS (
    SELECT t.id AS take_id, m.id, m.output_url, m.created_at,
           CASE WHEN jsonb_typeof(m.provider_snapshot->'durationMs') = 'number'
                THEN (m.provider_snapshot->>'durationMs')::bigint END AS duration_ms
    FROM iclip.generation_jobs m
    JOIN takes t ON t.id = m.root_job_id
    LEFT JOIN iclip.conversations mc ON mc.id = m.conversation_id
    WHERE m.kind = 'clip' AND m.request->>'purpose' = 'master' AND m.status = 'completed'
      AND m.output_url IS NOT NULL AND mc.deleted_at IS NULL
),
master_lists AS (
    SELECT m.take_id,
           jsonb_agg(jsonb_build_object('id', m.id, 'output_url', m.output_url,
                                        'duration_ms', m.duration_ms, 'created_at', m.created_at)
                     ORDER BY m.created_at, m.id) AS masters,
           (array_agg(m.id ORDER BY m.created_at DESC, m.id DESC))[1] AS master_id,
           (array_agg(m.output_url ORDER BY m.created_at DESC, m.id DESC))[1] AS master_url,
           (array_agg(m.duration_ms ORDER BY m.created_at DESC, m.id DESC))[1]
               AS master_duration_ms,
           max(m.created_at) AS master_at
    FROM masters m
    GROUP BY m.take_id
),
faces AS (
    SELECT t.*, ml.master_id, ml.master_url, ml.master_duration_ms,
           COALESCE(ml.master_at, t.created_at) AS face_at,
           COALESCE(ml.masters, '[]'::jsonb) AS masters,
           CASE WHEN t.request->>'aspect_ratio' ~ '^[0-9]+(\.[0-9]+)?:[0-9]+(\.[0-9]+)?$' THEN
               CASE sign(split_part(t.request->>'aspect_ratio', ':', 1)::numeric
                         - split_part(t.request->>'aspect_ratio', ':', 2)::numeric)
                   WHEN 1 THEN 'landscape' WHEN -1 THEN 'portrait' ELSE 'square' END
           END AS orientation
    FROM takes t
    LEFT JOIN master_lists ml ON ml.take_id = t.id
),
cards AS (
    SELECT DISTINCT ON (f.shot_key) f.*, count(*) OVER (PARTITION BY f.shot_key) AS take_count
    FROM faces f
    ORDER BY f.shot_key, f.face_at DESC, f.id DESC
)
"""

_FILTER: Final = r"""
WHERE (CAST(:user_name AS text) IS NULL OR c.user_name = CAST(:user_name AS text))
  AND (CAST(:since AS timestamptz) IS NULL OR c.face_at >= CAST(:since AS timestamptz))
  AND (CAST(:until AS timestamptz) IS NULL OR c.face_at < CAST(:until AS timestamptz))
  AND (CAST(:orientation AS text) IS NULL OR c.orientation = CAST(:orientation AS text))
  AND (CAST(:pattern AS text) IS NULL
       OR c.request->>'prompt' ILIKE CAST(:pattern AS text) ESCAPE '\'
       OR c.title ILIKE CAST(:pattern AS text) ESCAPE '\')
"""

_VIDEOS: Final = text(
    _BASE
    + "SELECT c.* FROM cards c"
    + _FILTER
    + """
  AND (CAST(:after_at AS timestamptz) IS NULL
       OR (c.face_at, c.id) < (CAST(:after_at AS timestamptz), CAST(:after_id AS uuid)))
ORDER BY c.face_at DESC, c.id DESC
LIMIT :limit"""
)

_COUNT: Final = text(_BASE + "SELECT count(*) AS n FROM cards c" + _FILTER)

_CARD_OF: Final = text(
    _BASE
    + """
SELECT c.* FROM cards c
WHERE c.shot_key = (SELECT t.shot_key FROM takes t WHERE t.id = CAST(:video_id AS uuid))"""
)

_TAKES_OF: Final = text(
    _BASE
    + """
SELECT f.* FROM faces f
WHERE f.shot_key = (SELECT t.shot_key FROM takes t WHERE t.id = CAST(:video_id AS uuid))
ORDER BY f.created_at, f.id"""
)

_SIBLINGS_OF: Final = text(
    _BASE
    + """
SELECT c.* FROM cards c
JOIN takes own ON own.id = CAST(:video_id AS uuid)
WHERE c.conversation_id = own.conversation_id AND c.shot_key <> own.shot_key
ORDER BY c.shot_index NULLS LAST, c.face_at DESC, c.id DESC"""
)

_AUTHORS: Final = text(
    _BASE
    + """
SELECT c.user_name, count(*) AS n FROM cards c
WHERE c.user_name IS NOT NULL
GROUP BY c.user_name
ORDER BY n DESC, c.user_name"""
)


class _StoredCut(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)

    timestamps: tuple[float, float]
    prompt: str
    image_indexes: list[int]


class _StoredShot(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)

    global_settings: str
    timeline: list[_StoredCut]


class _StoredVideoRequest(BaseModel):
    """出片请求快照里资料库要读的那几项；快照由生成域受理时校验过，形状不对就是坏数据，照常报错。"""

    model_config = ConfigDict(extra="ignore", frozen=True)

    prompt: str
    shot: _StoredShot | None = None
    model: str | None = None
    aspect_ratio: str | None = None
    seconds: int | None = None
    resolution: str | None = None
    generate_audio: bool | None = None
    reference_image_urls: list[str] = []


def _script_of(request: _StoredVideoRequest) -> ScriptOut | None:
    """请求里带结构化镜头组就用它；只有正文的按拼装规则拆，拆不出来就是纯文本。"""

    if request.shot is not None:
        return ScriptOut(
            global_settings=request.shot.global_settings,
            timeline=[
                ScriptCutOut(
                    start=cut.timestamps[0],
                    end=cut.timestamps[1],
                    prompt=cut.prompt,
                    image_indexes=cut.image_indexes,
                )
                for cut in request.shot.timeline
            ],
        )
    parsed = parse_shot_prompt(request.prompt)
    if parsed is None:
        return None
    return ScriptOut(
        global_settings=parsed.global_settings,
        timeline=[
            ScriptCutOut(
                start=cut.timestamps[0],
                end=cut.timestamps[1],
                prompt=cut.prompt,
                image_indexes=list(cut.image_indexes),
            )
            for cut in parsed.timeline
        ],
    )


def _take_of(row: RowMapping) -> TakeOut:
    request = _StoredVideoRequest.model_validate(row["request"])
    return TakeOut(
        id=row["id"],
        created_at=row["created_at"],
        user_name=row["user_name"],
        model=request.model,
        aspect_ratio=request.aspect_ratio,
        seconds=request.seconds,
        resolution=request.resolution,
        generate_audio=request.generate_audio,
        output_url=row["output_url"],
        watermark_output_url=row["watermark_output_url"],
        prompt=request.prompt,
        script=_script_of(request),
        reference_image_urls=request.reference_image_urls,
        masters=[MasterOut.model_validate(master) for master in row["masters"]],
    )


def _card_of(row: RowMapping) -> CardRow:
    if row["master_id"] is None:
        face = FaceOut(
            kind="take",
            job_id=row["id"],
            output_url=row["output_url"],
            watermark_output_url=row["watermark_output_url"],
            duration_ms=None,
            created_at=row["face_at"],
        )
    else:
        face = FaceOut(
            kind="master",
            job_id=row["master_id"],
            output_url=row["master_url"],
            watermark_output_url=None,
            duration_ms=row["master_duration_ms"],
            created_at=row["face_at"],
        )
    video = LibraryVideoOut(
        id=row["id"],
        shot_index=row["shot_index"],
        conversation_id=row["conversation_id"],
        title=row["title"],
        agent_id=row["agent_id"],
        task_id=row["task_id"],
        take_count=int(row["take_count"]),
        face=face,
        take=_take_of(row),
    )
    return CardRow(video=video, conversation_owner=row["conversation_owner"])


def _like_pattern(q: str) -> str:
    """关键词按字面包含：``%``、``_`` 与转义符本身都转义掉。"""

    escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _scope_params(scope: Scope) -> dict[str, Any]:
    return {
        "user_name": scope.user_name,
        "since": scope.since,
        "until": scope.until,
        "orientation": scope.orientation,
        "pattern": None if scope.q is None else _like_pattern(scope.q),
    }


class PgLibraryReports:
    """``LibraryReports`` 的 Postgres 实现。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def videos(
        self, scope: Scope, *, limit: int, after: VideoCursor | None
    ) -> Sequence[CardRow]:
        params = {
            **_scope_params(scope),
            "after_at": after.at if after else None,
            "after_id": after.video_id if after else None,
            "limit": limit,
        }
        async with self._engine.connect() as conn:
            rows = (await conn.execute(_VIDEOS, params)).mappings().all()
        return [_card_of(row) for row in rows]

    async def count(self, scope: Scope) -> int:
        async with self._engine.connect() as conn:
            return int((await conn.execute(_COUNT, _scope_params(scope))).scalar_one())

    async def card_of(self, video_id: uuid.UUID) -> CardRow | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(_CARD_OF, {"video_id": video_id})).mappings().first()
        return None if row is None else _card_of(row)

    async def takes_of(self, video_id: uuid.UUID) -> Sequence[TakeOut]:
        async with self._engine.connect() as conn:
            rows = (await conn.execute(_TAKES_OF, {"video_id": video_id})).mappings().all()
        return [_take_of(row) for row in rows]

    async def siblings_of(self, video_id: uuid.UUID) -> Sequence[CardRow]:
        async with self._engine.connect() as conn:
            rows = (await conn.execute(_SIBLINGS_OF, {"video_id": video_id})).mappings().all()
        return [_card_of(row) for row in rows]

    async def authors(self) -> Sequence[LibraryAuthorOut]:
        async with self._engine.connect() as conn:
            rows = (await conn.execute(_AUTHORS)).mappings().all()
        return [LibraryAuthorOut(user_name=row["user_name"], count=int(row["n"])) for row in rows]


__all__ = ["PgLibraryReports"]
