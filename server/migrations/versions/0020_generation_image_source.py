"""iclip.generation_jobs：图片记来源，上传与切图各落一行；帧图编辑的 ``metadata.sourceUrl`` 迁成来源。

Revision ID: fd0a5be42793
Revises: 69f785644eb5
Create Date: 2026-09-25 23:00:00.000000

过去帧图编辑的底图只写在前端自己的 ``metadata.sourceUrl`` 里，库内底图说不出是哪一行。现在图片的
来历记成列：底图是库里的记录就填 ``source_job_id``，是外部地址就填新列 ``source_url``，两者恰好
一个。``request`` 改可空：上传与切图没有发给执行方的输入。``operation`` 多出 ``cut``（本地切图）
与 ``upload``（用户上传），两者创建即完成。

0020 之前没有切图行与上传行，回填只可能对上图片生成与帧图编辑的产物：已完成、产物地址就是那个
底图地址、完成时刻不晚于这次编辑的提交。匹配范围与受理一致：同一段对话（都没有对话也算同一段），
或它按「继承」读得到的祖先记录（沿分叉来源逐跳，边界是这条链上它的下一级对话的建立时刻）。不看
属主：迁移不知道当年的主体。对不上的记外部地址。回填后擦掉图片行上的 ``sourceUrl`` 键。

先核对，任何一条对不上就带 id 报错、整个迁移回滚：请求不是 JSON 对象、帧图编辑的
``metadata.sourceUrl`` 不是 http(s) 地址、一个底图地址对得上不止一条记录。回填后再核一遍每条帧图
编辑的来源是不是恰好一个。视频行的 ``metadata`` 是调用方的标签，一个键不动。

不可逆的部分：降级删掉切图行与上传行（旧版本读不了这两种行，桶里的字节还在），帧图编辑的来源
写回 ``metadata.sourceUrl``（库内来源取那条的产物地址）；切图或上传记录上挂着埋点事件就拒绝降级。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "fd0a5be42793"
down_revision: str | None = "69f785644eb5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "generation_jobs"
JOBS = f"{SCHEMA}.{TABLE}"
CONVERSATIONS = f"{SCHEMA}.conversations"
EVENTS = f"{SCHEMA}.tracking_events"

_EDITS = "kind = 'image' AND jsonb_exists(metadata, 'sourceUrl')"
"""带底图地址的图片行，也就是 0020 之前的帧图编辑。视频行的 metadata 是调用方的标签，不动。"""

_HTTP_URL = "{value} ~* '^https?://[^/?#:@[:space:]]' AND {value} !~ '[[:space:]]'"
"""与请求字段 ``sourceUrl`` 的校验（``common.urls.is_http_url``）同一口径：scheme 不分大小写、
紧跟着主机、整串没有空白。"""

_INDEX = "ix_generation_jobs_conversation_image_output"
_INDEX_WHERE = "kind = 'image' AND output_url IS NOT NULL"
"""与 ``infra_sql.generation_jobs_table`` 上声明的同名同式。"""

_OLD_CHECKS: tuple[tuple[str, str], ...] = (
    ("ck_generation_jobs_kind", "kind IN ('video', 'image')"),
    ("ck_generation_jobs_operation", "operation IN ('generate', 'compose')"),
    (
        "ck_generation_jobs_video_shape",
        "kind <> 'video'"
        " OR (operation = 'generate' AND source_job_id IS NULL AND root_job_id IS NULL"
        " AND range_start_ms IS NULL AND range_end_ms IS NULL)"
        " OR (operation = 'generate' AND source_job_id IS NOT NULL AND root_job_id IS NOT NULL"
        " AND range_start_ms IS NOT NULL AND range_end_ms IS NOT NULL"
        " AND range_start_ms >= 0 AND range_end_ms > range_start_ms)"
        " OR (operation = 'compose' AND source_job_id IS NOT NULL AND root_job_id IS NOT NULL"
        " AND range_start_ms IS NULL AND range_end_ms IS NULL)",
    ),
    (
        "ck_generation_jobs_image_shape",
        "kind <> 'image'"
        " OR (operation = 'generate' AND source_job_id IS NULL AND root_job_id IS NULL"
        " AND range_start_ms IS NULL AND range_end_ms IS NULL)",
    ),
)
"""0017 建的四条，原文照抄：它们不许图片行有来源，回填前得删；降级时照它重建。"""

_CHECKS: tuple[tuple[str, str], ...] = (
    ("ck_generation_jobs_kind", "kind IN ('video', 'image')"),
    ("ck_generation_jobs_operation", "operation IN ('generate', 'compose', 'cut', 'upload')"),
    (
        "ck_generation_jobs_request",
        "(operation IN ('cut', 'upload') AND request IS NULL)"
        " OR (operation IN ('generate', 'compose') AND request IS NOT NULL"
        " AND jsonb_typeof(request) = 'object')",
    ),
    (
        "ck_generation_jobs_video_shape",
        "kind <> 'video' OR (source_url IS NULL AND ("
        "(operation = 'generate' AND source_job_id IS NULL AND root_job_id IS NULL"
        " AND range_start_ms IS NULL AND range_end_ms IS NULL)"
        " OR (operation = 'generate' AND source_job_id IS NOT NULL AND root_job_id IS NOT NULL"
        " AND range_start_ms IS NOT NULL AND range_end_ms IS NOT NULL"
        " AND range_start_ms >= 0 AND range_end_ms > range_start_ms)"
        " OR (operation = 'compose' AND source_job_id IS NOT NULL AND root_job_id IS NOT NULL"
        " AND range_start_ms IS NULL AND range_end_ms IS NULL)"
        " OR operation = 'upload'))",
    ),
    (
        "ck_generation_jobs_image_shape",
        "kind <> 'image' OR (root_job_id IS NULL AND range_start_ms IS NULL"
        " AND range_end_ms IS NULL AND ("
        "(operation = 'generate' AND (source_job_id IS NULL OR source_url IS NULL))"
        " OR operation IN ('cut', 'upload')))",
    ),
    (
        "ck_generation_jobs_cut_shape",
        "operation <> 'cut'"
        " OR (kind = 'image' AND source_job_id IS NOT NULL AND source_url IS NULL)",
    ),
    (
        "ck_generation_jobs_upload_shape",
        "operation <> 'upload' OR (conversation_id IS NULL AND source_job_id IS NULL"
        " AND source_url IS NULL AND root_job_id IS NULL"
        " AND range_start_ms IS NULL AND range_end_ms IS NULL)",
    ),
    (
        "ck_generation_jobs_settled",
        "operation NOT IN ('cut', 'upload')"
        " OR (status = 'completed' AND output_url IS NOT NULL AND finished_at IS NOT NULL)",
    ),
)
"""与 ``infra_sql.generation_jobs_table`` 上声明的同名同式。"""

_CANDIDATES = f"""
    WITH RECURSIVE edits AS (
        SELECT id, conversation_id, created_at, metadata->>'sourceUrl' AS url
        FROM {JOBS} WHERE {_EDITS}
    ),
    lineage AS (
        SELECT d.id AS edit_id, c.forked_from AS ancestor, c.created_at AS boundary
        FROM edits d JOIN {CONVERSATIONS} c ON c.id = d.conversation_id
        WHERE c.forked_from IS NOT NULL
        UNION ALL
        SELECT l.edit_id, p.forked_from, p.created_at
        FROM lineage l JOIN {CONVERSATIONS} p ON p.id = l.ancestor
        WHERE p.forked_from IS NOT NULL
    ),
    candidates AS (
        SELECT d.id AS edit_id, x.id AS source_id
        FROM edits d
        JOIN {JOBS} x
          ON x.kind = 'image' AND x.status = 'completed' AND x.output_url = d.url AND x.id <> d.id
        WHERE (x.conversation_id IS NOT DISTINCT FROM d.conversation_id
               AND x.finished_at <= d.created_at)
           OR EXISTS (
               SELECT 1 FROM lineage l
               WHERE l.edit_id = d.id AND x.conversation_id = l.ancestor
                 AND x.finished_at <= l.boundary
           )
    )
"""
"""每条帧图编辑对得上的库内底图。祖先与边界逐跳同 ``conversations.ancestry``；本对话那一支的
「都没有对话也算同一段」与受理时 ``conversation_id IS NULL`` 那一支一致。"""


def upgrade() -> None:
    _check_existing_rows()

    op.add_column(TABLE, sa.Column("source_url", sa.Text(), nullable=True), schema=SCHEMA)
    op.alter_column(TABLE, "request", nullable=True, schema=SCHEMA)
    # 增删对称：kind 那条内容不变也照删照建，免得下面建八条时撞名。
    for name, _ in reversed(_OLD_CHECKS):
        op.drop_constraint(name, TABLE, type_="check", schema=SCHEMA)

    op.execute(
        f"""
        {_CANDIDATES}
        UPDATE {JOBS} AS e SET source_job_id = c.source_id
        FROM candidates AS c WHERE e.id = c.edit_id
        """
    )
    op.execute(
        f"""
        UPDATE {JOBS} SET source_url = metadata->>'sourceUrl'
        WHERE {_EDITS} AND source_job_id IS NULL
        """
    )
    _require_empty(
        f"""
        SELECT id FROM {JOBS}
        WHERE {_EDITS} AND (source_job_id IS NULL) = (source_url IS NULL)
        ORDER BY 1
        """,
        "帧图编辑回填后来源不是恰好一个",
    )
    op.execute(
        f"""
        UPDATE {JOBS} SET metadata = NULLIF(metadata - 'sourceUrl', '{{}}'::jsonb)
        WHERE {_EDITS}
        """
    )

    for name, condition in _CHECKS:
        op.create_check_constraint(name, TABLE, condition, schema=SCHEMA)
    op.create_index(
        _INDEX,
        TABLE,
        ["conversation_id", "output_url"],
        schema=SCHEMA,
        postgresql_where=sa.text(_INDEX_WHERE),
    )


def _check_existing_rows() -> None:
    """回填与新约束依赖的形状逐条核对；对不上的交人判断，不猜。"""

    _require_empty(
        f"SELECT id FROM {JOBS} WHERE jsonb_typeof(request) IS DISTINCT FROM 'object' ORDER BY 1",
        "请求不是 JSON 对象，先人工处理",
    )
    # 先判类型再取文本：坐标是前端手写的 JSON，不是字符串的直接算对不上。
    sources = "metadata->>'sourceUrl'"
    _require_empty(
        f"""
        SELECT id FROM {JOBS}
        WHERE {_EDITS}
          AND NOT (jsonb_typeof(metadata->'sourceUrl') = 'string'
                   AND {_HTTP_URL.format(value=sources)})
        ORDER BY 1
        """,
        "帧图编辑的 metadata.sourceUrl 不是 http(s) 地址，先人工处理",
    )
    # 产物地址按任务 id 命名，正常不会重；重了说不清是哪一条，交人判断。
    _require_empty(
        f"""
        {_CANDIDATES}
        SELECT edit_id FROM candidates GROUP BY edit_id HAVING count(*) > 1 ORDER BY 1
        """,
        "帧图编辑的底图地址对得上不止一条记录，先人工处理",
    )


def downgrade() -> None:
    """帧图编辑的来源写回 ``metadata.sourceUrl``，删掉切图行与上传行，再收回列与约束。"""

    _require_empty(
        f"""
        SELECT DISTINCT g.id FROM {EVENTS} AS t
        JOIN {JOBS} AS g ON g.id = t.job_id
        WHERE g.operation IN ('cut', 'upload')
        ORDER BY 1
        """,
        "切图或上传记录上挂着埋点事件，删不掉，拒绝降级",
    )
    # 写回要在清来源之前。metadata 可能是 JSON null（仓储把 None 存成它），不是对象就从空对象起，
    # 否则 || 会把两边拼成一个数组。
    op.execute(
        f"""
        UPDATE {JOBS} AS e
        SET metadata = {_object_or_empty("e.metadata")}
            || jsonb_build_object('sourceUrl', s.output_url)
        FROM {JOBS} AS s
        WHERE s.id = e.source_job_id AND e.kind = 'image' AND e.operation = 'generate'
        """
    )
    op.execute(
        f"""
        UPDATE {JOBS}
        SET metadata = {_object_or_empty("metadata")}
            || jsonb_build_object('sourceUrl', source_url)
        WHERE source_url IS NOT NULL
        """
    )
    op.execute(
        f"""
        UPDATE {JOBS} SET source_job_id = NULL
        WHERE kind = 'image' AND operation = 'generate' AND source_job_id IS NOT NULL
        """
    )
    # 图片生成已不再指向它们；视频的基底只能是成片，指不到上传行；切图行之间互不引用。
    op.execute(f"DELETE FROM {JOBS} WHERE operation IN ('cut', 'upload')")

    op.drop_index(_INDEX, TABLE, schema=SCHEMA)
    for name, _ in reversed(_CHECKS):
        op.drop_constraint(name, TABLE, type_="check", schema=SCHEMA)
    op.drop_column(TABLE, "source_url", schema=SCHEMA)
    op.alter_column(TABLE, "request", nullable=False, schema=SCHEMA)
    for name, condition in _OLD_CHECKS:
        op.create_check_constraint(name, TABLE, condition, schema=SCHEMA)


def _object_or_empty(column: str) -> str:
    return f"CASE WHEN jsonb_typeof({column}) = 'object' THEN {column} ELSE '{{}}'::jsonb END"


def _require_empty(query: str, message: str) -> None:
    found = op.get_bind().execute(sa.text(query)).scalars().all()
    if found:
        raise RuntimeError(f"{message}：{[str(item) for item in found]}")
