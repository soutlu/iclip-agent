"""资料库的 Postgres 查询：跨生成记录、对话、用户三张表只读，不建表、不写入。

SQL 与本模块里的 'video' / 'generate' / 'compose' / 'completed' 镜像生成域的 KIND_VIDEO /
OPERATION_GENERATE / OPERATION_COMPOSE / STATUS_COMPLETED（按表名直接查，不 import 业务模块）；
集成测试的种子取自那些常量，生成域改词这里的用例就红。外部输入一律走绑定参数。

继承规则在这里照 ``conversations.infra_sql.ancestry`` 与 ``generation.infra_sql._inherited``
手写了一份：模块边界不让复用，ADR-0002 取舍第 2 条接受这份重复；两份由同一个分叉场景
（tests/helpers/fork_lineage.py）钉住，漂了会现形。

列表层不碰血缘（ADR-0002 决策 3）：继承来的行完成时刻不晚于副本的建立时刻；副本 id 由服务端
在分叉时铸，挂副本的行都在副本建立之后才落。所以对话自己最新的成片就是整卡最新的：有没有卡、
卡面、排序、游标与筛选都只看自己的行，只有组数、版数与详情要用血缘，列表里也只算当页那几张卡。
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Any, Final

from pydantic import BaseModel, ConfigDict
from sqlalchemy import TextClause, text
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.common.shot_prompt import parse_shot_prompt
from iclip.domains.library.models import Scope, VideoCursor
from iclip.domains.library.repository import CardRow
from iclip.domains.library.schemas import (
    FaceOut,
    LibraryAuthorOut,
    LibraryVideoOut,
    ScriptCutOut,
    ScriptOut,
    ShotGroupOut,
    TakeOut,
    VersionOut,
)

_COMPOSE: Final = "compose"

# ---------------------------------------------------------------------------
# CTE 体，按「一个 WITH RECURSIVE 前缀 + 逗号拼接」组装成语句：
# own_masters 候选行：每条成片只进自己的卡；卡 id 是存在的对话，不挂对话的按原作；
# faces       卡面：卡自己最新的成片；
# cards       一张卡一行，卡面那一版对应的出片可能在祖先对话里，绝不按对话过滤；
# seeds       要装填的卡：列表是当页，详情是那一张（不是卡的 id 就没有种子）；
# lineage     每张卡的对话沿 forked_from 往上，逐跳带边界；
# visible     每张卡读得到的成片：自己的加继承来的，不挂对话的卡是出片与同原作的合成；
# fill        每张卡的组数与版数。
# ---------------------------------------------------------------------------

_MASTER: Final = """g.kind = 'video' AND g.status = 'completed' AND g.output_url IS NOT NULL
      AND (g.operation = 'compose' OR (g.operation = 'generate' AND g.source_job_id IS NULL))"""
"""成片：已完成、有地址的出片（没有来源的视频 generate）或合成；按别名 ``g`` 拼进条件。"""

_JOB_COLUMNS: Final = """g.id, g.operation, g.shot_index, g.root_job_id, g.output_url,
           g.watermark_output_url, g.duration_ms, g.finished_at, g.owner_user_id"""

_OWN_MASTERS: Final = f"""
own_masters AS (
    SELECT g.id, g.operation, g.output_url, g.watermark_output_url, g.duration_ms,
           g.finished_at, g.owner_user_id, c.id AS card_conversation,
           COALESCE(c.id, g.root_job_id, g.id) AS card_id,
           COALESCE(g.root_job_id, g.id) AS take_id
    FROM iclip.generation_jobs g
    LEFT JOIN iclip.conversations c ON c.id = g.conversation_id
    WHERE {_MASTER}
)"""

_FACES: Final = """
faces AS (
    SELECT DISTINCT ON (m.card_id) m.*
    FROM own_masters m
    ORDER BY m.card_id, m.finished_at DESC, m.id DESC
)"""

_CARDS: Final = r"""
cards AS (
    SELECT f.card_id AS id, f.card_conversation AS conversation_id,
           f.id AS face_id, f.operation AS face_operation, f.output_url AS face_output_url,
           f.watermark_output_url AS face_watermark_output_url,
           f.duration_ms AS face_duration_ms, f.finished_at AS face_finished_at,
           fu.username AS face_user_name,
           t.id AS take_id, t.request AS take_request,
           c.title, c.agent_id, c.task_id, c.owner_user_id AS conversation_owner,
           c.deleted_at IS NOT NULL AS conversation_deleted,
           au.username AS user_name,
           CASE WHEN t.request->>'aspect_ratio' ~ '^[0-9]+(\.[0-9]+)?:[0-9]+(\.[0-9]+)?$' THEN
               CASE sign(split_part(t.request->>'aspect_ratio', ':', 1)::numeric
                         - split_part(t.request->>'aspect_ratio', ':', 2)::numeric)
                   WHEN 1 THEN 'landscape' WHEN -1 THEN 'portrait' ELSE 'square' END
           END AS orientation
    FROM faces f
    JOIN iclip.generation_jobs t ON t.id = f.take_id
    JOIN iclip.users fu ON fu.id = f.owner_user_id
    LEFT JOIN iclip.conversations c ON c.id = f.card_conversation
    JOIN iclip.users au ON au.id = COALESCE(c.owner_user_id, t.owner_user_id)
)"""

_FILTER: Final = r"""
WHERE (CAST(:user_name AS text) IS NULL OR c.user_name = CAST(:user_name AS text))
  AND (CAST(:since AS timestamptz) IS NULL OR c.face_finished_at >= CAST(:since AS timestamptz))
  AND (CAST(:until AS timestamptz) IS NULL OR c.face_finished_at < CAST(:until AS timestamptz))
  AND (CAST(:orientation AS text) IS NULL OR c.orientation = CAST(:orientation AS text))
  AND (CAST(:pattern AS text) IS NULL
       OR c.take_request->>'prompt' ILIKE CAST(:pattern AS text) ESCAPE '\'
       OR c.title ILIKE CAST(:pattern AS text) ESCAPE '\')"""

_PAGE: Final = f"""
page AS (
    SELECT c.* FROM cards c{_FILTER}
      AND (CAST(:after_at AS timestamptz) IS NULL
           OR (c.face_finished_at, c.id)
              < (CAST(:after_at AS timestamptz), CAST(:after_id AS uuid)))
    ORDER BY c.face_finished_at DESC, c.id DESC
    LIMIT :limit
)"""

_SEEDS_OF_PAGE: Final = """
seeds AS (SELECT p.id FROM page p)"""

_SEEDS_OF_CARD: Final = """
seeds AS (SELECT c.id FROM cards c WHERE c.id = CAST(:card_id AS uuid))"""

_LINEAGE: Final = """
lineage AS (
    -- 种子是卡的对话本身，边界为空：自己的行不设界
    SELECT c.id AS card_id, c.id AS conversation_id, c.forked_from, c.created_at,
           CAST(NULL AS timestamptz) AS boundary
    FROM seeds s
    JOIN iclip.conversations c ON c.id = s.id
    UNION ALL
    -- 每跳取上一级，边界是这条链上它的下一级（刚走过的那段）的建立时刻；不看删除标记
    SELECT l.card_id, p.id, p.forked_from, p.created_at, l.created_at
    FROM lineage l
    JOIN iclip.conversations p ON p.id = l.forked_from
)"""

_VISIBLE: Final = f"""
visible AS (
    SELECT l.card_id, {_JOB_COLUMNS}
    FROM lineage l
    JOIN iclip.generation_jobs g ON g.conversation_id = l.conversation_id
    WHERE {_MASTER}
      AND (l.boundary IS NULL OR (g.status = 'completed' AND g.finished_at <= l.boundary))
    UNION ALL
    -- 不挂对话的卡：那条出片与同原作的合成，没有血缘
    SELECT COALESCE(g.root_job_id, g.id), {_JOB_COLUMNS}
    FROM iclip.generation_jobs g
    LEFT JOIN iclip.conversations c ON c.id = g.conversation_id
    WHERE {_MASTER} AND c.id IS NULL
      AND COALESCE(g.root_job_id, g.id) IN (SELECT s.id FROM seeds s)
)"""

_FILL: Final = """
fill AS (
    -- 组键与 _groups_of 同一口径：有镜号按镜号，没镜号按原作
    SELECT v.card_id, count(*) AS version_count,
           count(DISTINCT COALESCE('#' || v.shot_index::text,
                                   COALESCE(v.root_job_id, v.id)::text)) AS group_count
    FROM visible v
    GROUP BY v.card_id
)"""


def _statement(ctes: Sequence[str], body: str) -> TextClause:
    return text("WITH RECURSIVE" + ",".join(ctes) + "\n" + body)


_CARD_CTES: Final = (_OWN_MASTERS, _FACES, _CARDS)
_LINEAGE_CTES: Final = (_LINEAGE, _VISIBLE)

_VIDEOS: Final = _statement(
    (*_CARD_CTES, _PAGE, _SEEDS_OF_PAGE, *_LINEAGE_CTES, _FILL),
    """SELECT p.*, f.group_count, f.version_count
FROM page p
JOIN fill f ON f.card_id = p.id
ORDER BY p.face_finished_at DESC, p.id DESC""",
)

_COUNT: Final = _statement(_CARD_CTES, "SELECT count(*) AS n FROM cards c" + _FILTER)

_CARD_OF: Final = _statement(
    (*_CARD_CTES, _SEEDS_OF_CARD, *_LINEAGE_CTES, _FILL),
    """SELECT c.*, f.group_count, f.version_count
FROM cards c
JOIN fill f ON f.card_id = c.id
WHERE c.id = CAST(:card_id AS uuid)""",
)

_VERSIONS: Final = _statement(
    (*_CARD_CTES, _SEEDS_OF_CARD, *_LINEAGE_CTES),
    """SELECT v.id, v.operation, v.shot_index, v.output_url, v.watermark_output_url,
       v.duration_ms, v.finished_at, u.username AS user_name,
       t.id AS take_id, t.request AS take_request
FROM visible v
-- 合成沿原作取脚本与参数；原作按构造一定读得到，内连接
JOIN iclip.generation_jobs t ON t.id = COALESCE(v.root_job_id, v.id)
JOIN iclip.users u ON u.id = v.owner_user_id
ORDER BY v.finished_at, v.id""",
)

_AUTHORS: Final = _statement(
    _CARD_CTES,
    """SELECT c.user_name, count(*) AS n FROM cards c
WHERE c.user_name IS NOT NULL
GROUP BY c.user_name
ORDER BY n DESC, c.user_name""",
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


def _take_of(take_id: uuid.UUID, stored: object) -> TakeOut:
    request = _StoredVideoRequest.model_validate(stored)
    return TakeOut(
        id=take_id,
        model=request.model,
        aspect_ratio=request.aspect_ratio,
        seconds=request.seconds,
        resolution=request.resolution,
        generate_audio=request.generate_audio,
        prompt=request.prompt,
        script=_script_of(request),
        reference_image_urls=request.reference_image_urls,
    )


def _face_of(row: RowMapping, prefix: str = "") -> FaceOut:
    """版本头；卡上的列带 ``face_`` 前缀，版本行上的不带。"""

    return FaceOut(
        kind="composite" if row[f"{prefix}operation"] == _COMPOSE else "take",
        job_id=row[f"{prefix}id"],
        output_url=row[f"{prefix}output_url"],
        watermark_output_url=row[f"{prefix}watermark_output_url"],
        duration_ms=row[f"{prefix}duration_ms"],
        finished_at=row[f"{prefix}finished_at"],
        user_name=row[f"{prefix}user_name"],
    )


def _version_of(row: RowMapping) -> VersionOut:
    return VersionOut(
        **_face_of(row).model_dump(), take=_take_of(row["take_id"], row["take_request"])
    )


def _card_of(row: RowMapping) -> CardRow:
    video = LibraryVideoOut(
        id=row["id"],
        conversation_id=row["conversation_id"],
        can_open_conversation=False,
        title=row["title"],
        agent_id=row["agent_id"],
        task_id=row["task_id"],
        user_name=row["user_name"],
        group_count=int(row["group_count"]),
        version_count=int(row["version_count"]),
        face=_face_of(row, "face_"),
        take=_take_of(row["take_id"], row["take_request"]),
    )
    return CardRow(
        video=video,
        conversation_owner=row["conversation_owner"],
        conversation_deleted=bool(row["conversation_deleted"]),
    )


def _groups_of(rows: Sequence[RowMapping]) -> list[ShotGroupOut]:
    """把按完成时刻排好的版本行分成镜头组，组键与 ``_FILL`` 同一口径。

    有镜号的组按镜号从小到大在前；没镜号的组是一条出片连同同原作的合成，排在后面，按组里第一版
    （出片）的完成先后——稳定排序保留了插入序。"""

    groups: dict[tuple[str, int | uuid.UUID], tuple[int | None, list[VersionOut]]] = {}
    for row in rows:
        shot: int | None = row["shot_index"]
        key = ("#", shot) if shot is not None else ("@", row["take_id"])
        groups.setdefault(key, (shot, []))[1].append(_version_of(row))
    ordered = sorted(groups.values(), key=lambda group: (group[0] is None, group[0] or 0))
    return [ShotGroupOut(shot_index=shot, versions=versions) for shot, versions in ordered]


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

    async def card_of(self, card_id: uuid.UUID) -> CardRow | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(_CARD_OF, {"card_id": card_id})).mappings().first()
        return None if row is None else _card_of(row)

    async def groups_of(self, card_id: uuid.UUID) -> Sequence[ShotGroupOut]:
        async with self._engine.connect() as conn:
            rows = (await conn.execute(_VERSIONS, {"card_id": card_id})).mappings().all()
        return _groups_of(rows)

    async def authors(self) -> Sequence[LibraryAuthorOut]:
        async with self._engine.connect() as conn:
            rows = (await conn.execute(_AUTHORS)).mappings().all()
        return [LibraryAuthorOut(user_name=row["user_name"], count=int(row["n"])) for row in rows]


__all__ = ["PgLibraryReports"]
