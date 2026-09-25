"""iclip.generation_jobs：一行一次操作，记录上加操作、直接来源与编辑区间，参考片段不再落行。

Revision ID: 7c50c7336e0c
Revises: 2f9ffd7b9bbe
Create Date: 2026-09-25 10:00:00.000000

过去一行是什么角色，要从 kind、原作号、``request.purpose`` 与 ``metadata`` 里的编辑坐标拼出来。
现在 ``operation`` 说怎么执行（调模型 generate、本地拼接 compose），``source_job_id`` 说直接基于
哪一行，编辑段在基底上改的那一段记成 ``range_start_ms`` / ``range_end_ms``；``kind`` 只剩 video
与 image。

存量先核对，任何一条对不上就带 id 报错、整个迁移回滚：clip 的 purpose 不认识、参考片段上挂着
埋点事件、编辑结果缺坐标或坐标不成区间、成片没有 editId、``baseEdit`` 找不到同链里已完成的成片、
成片找不到同链里更早的编辑结果、图片带着原作号。然后删掉参考片段（切给模型看的中间素材，桶上
按前缀过期）；clip 成片改记 video / compose，request 里去掉 purpose；编辑结果的来源按 ``baseEdit``
找那次成片、没有就是原作，区间由坐标换算成毫秒；成片的来源取同链同 editId、在它之前建立的最新
一条编辑结果。编辑结果的 request 不改写。最后擦掉四个编辑坐标键，收紧非空、外键、部分索引与
四条组合约束。

不可逆的部分：删掉的参考片段降级不造回；降级时 editId 用编辑段自己的 id 重建，不是当年前端铸的
值；0017 之后新建的合成带着取到结尾的段，旧形状表达不了，有这种行就拒绝降级。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "7c50c7336e0c"
down_revision: str | None = "2f9ffd7b9bbe"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "generation_jobs"
JOBS = f"{SCHEMA}.{TABLE}"
EVENTS = f"{SCHEMA}.tracking_events"

_EDIT_KEYS = "ARRAY['editId', 'baseEdit', 'editStart', 'editEnd']"

_CHECKS: tuple[tuple[str, str], ...] = (
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
"""与 ``infra_sql.generation_jobs_table`` 上声明的同名同式。"""


def upgrade() -> None:
    _check_existing_rows()
    op.execute(f"DELETE FROM {JOBS} WHERE kind = 'clip' AND request->>'purpose' = 'reference'")

    op.add_column(TABLE, sa.Column("operation", sa.Text(), nullable=True), schema=SCHEMA)
    op.add_column(TABLE, sa.Column("source_job_id", sa.Uuid(), nullable=True), schema=SCHEMA)
    op.add_column(TABLE, sa.Column("range_start_ms", sa.Integer(), nullable=True), schema=SCHEMA)
    op.add_column(TABLE, sa.Column("range_end_ms", sa.Integer(), nullable=True), schema=SCHEMA)

    op.execute(
        f"UPDATE {JOBS} SET operation = CASE WHEN kind = 'clip' THEN 'compose' ELSE 'generate' END"
    )
    op.execute(
        f"UPDATE {JOBS} SET kind = 'video', request = request - 'purpose' WHERE kind = 'clip'"
    )
    # 编辑结果：来源按 baseEdit 找同链里那次已完成的成片（重新合成过就取最后完成的那条），
    # 没有 baseEdit 就是基于原片；区间是坐标里的秒换成毫秒。相关子查询而不是 UPDATE … FROM
    # LATERAL：后者不能引用被更新的表。
    op.execute(
        f"""
        UPDATE {JOBS} AS e
        SET source_job_id = CASE
                WHEN jsonb_exists(e.metadata, 'baseEdit') THEN (
                    SELECT m.id FROM {JOBS} AS m
                    WHERE m.operation = 'compose' AND m.status = 'completed'
                      AND m.root_job_id = e.root_job_id
                      AND m.metadata->>'editId' = e.metadata->>'baseEdit'
                    ORDER BY m.finished_at DESC NULLS LAST, m.created_at DESC, m.id DESC
                    LIMIT 1
                )
                ELSE e.root_job_id
            END,
            range_start_ms = round((e.metadata->>'editStart')::numeric * 1000)::int,
            range_end_ms = round((e.metadata->>'editEnd')::numeric * 1000)::int
        WHERE e.kind = 'video' AND e.operation = 'generate' AND e.root_job_id IS NOT NULL
        """
    )
    # 成片：来源是同链同 editId、在它之前建立的最新一条编辑结果。
    op.execute(
        f"""
        UPDATE {JOBS} AS m
        SET source_job_id = (
            SELECT e.id FROM {JOBS} AS e
            WHERE e.kind = 'video' AND e.operation = 'generate'
              AND e.root_job_id = m.root_job_id
              AND e.metadata->>'editId' = m.metadata->>'editId'
              AND e.created_at < m.created_at
            ORDER BY e.created_at DESC, e.id DESC
            LIMIT 1
        )
        WHERE m.operation = 'compose'
        """
    )
    _require_empty(
        f"SELECT id FROM {JOBS} WHERE root_job_id IS NOT NULL AND source_job_id IS NULL",
        "编辑结果或成片回填后仍没有来源，先人工处理",
    )
    op.execute(
        f"""
        UPDATE {JOBS}
        SET metadata = NULLIF(metadata - {_EDIT_KEYS}, '{{}}'::jsonb)
        WHERE jsonb_exists_any(metadata, {_EDIT_KEYS})
        """
    )

    op.alter_column(TABLE, "operation", nullable=False, schema=SCHEMA)
    op.create_foreign_key(
        "fk_generation_jobs_source_job",
        TABLE,
        TABLE,
        ["source_job_id"],
        ["id"],
        source_schema=SCHEMA,
        referent_schema=SCHEMA,
    )
    op.create_index(
        "ix_generation_jobs_source_job",
        TABLE,
        ["source_job_id"],
        schema=SCHEMA,
        postgresql_where=sa.text("source_job_id IS NOT NULL"),
    )
    for name, condition in _CHECKS:
        op.create_check_constraint(name, TABLE, condition, schema=SCHEMA)


def _check_existing_rows() -> None:
    """回填依赖的形状逐条核对；对不上的不静默落成别的角色。"""

    _require_empty(
        f"""
        SELECT id FROM {JOBS}
        WHERE kind = 'clip' AND COALESCE(request->>'purpose', '') NOT IN ('reference', 'master')
        """,
        "clip 记录的 purpose 既不是 reference 也不是 master，先人工处理",
    )
    _require_empty(
        f"""
        SELECT DISTINCT g.id FROM {EVENTS} AS t
        JOIN {JOBS} AS g ON g.id = t.job_id
        WHERE g.kind = 'clip' AND g.request->>'purpose' = 'reference'
        """,
        "参考片段上挂着埋点事件，删不掉，先人工处理",
    )
    # CASE 保证先判类型再转数字：坐标是前端手写的 JSON，类型不对时不能让整个迁移以转换错误崩掉。
    _require_empty(
        f"""
        SELECT id FROM {JOBS}
        WHERE kind = 'video' AND root_job_id IS NOT NULL
          AND NOT CASE
              WHEN jsonb_typeof(metadata->'editId') = 'string'
               AND jsonb_typeof(metadata->'editStart') = 'number'
               AND jsonb_typeof(metadata->'editEnd') = 'number'
              THEN (metadata->>'editStart')::numeric >= 0
               AND round((metadata->>'editEnd')::numeric * 1000)
                   > round((metadata->>'editStart')::numeric * 1000)
              ELSE false
          END
        """,
        "编辑结果缺编辑坐标或坐标不成区间，先人工处理",
    )
    _require_empty(
        f"""
        SELECT id FROM {JOBS}
        WHERE kind = 'clip' AND request->>'purpose' = 'master'
          AND jsonb_typeof(metadata->'editId') IS DISTINCT FROM 'string'
        """,
        "成片没有 editId，先人工处理",
    )
    _require_empty(
        f"""
        SELECT e.id FROM {JOBS} AS e
        WHERE e.kind = 'video' AND e.root_job_id IS NOT NULL
          AND jsonb_exists(e.metadata, 'baseEdit')
          AND NOT EXISTS (
              SELECT 1 FROM {JOBS} AS m
              WHERE m.kind = 'clip' AND m.request->>'purpose' = 'master'
                AND m.status = 'completed' AND m.root_job_id = e.root_job_id
                AND m.metadata->>'editId' = e.metadata->>'baseEdit'
          )
        """,
        "编辑结果的 baseEdit 找不到同链里已完成的成片，先人工处理",
    )
    _require_empty(
        f"""
        SELECT m.id FROM {JOBS} AS m
        WHERE m.kind = 'clip' AND m.request->>'purpose' = 'master'
          AND NOT EXISTS (
              SELECT 1 FROM {JOBS} AS e
              WHERE e.kind = 'video' AND e.root_job_id = m.root_job_id
                AND e.metadata->>'editId' = m.metadata->>'editId'
                AND e.created_at < m.created_at
          )
        """,
        "成片找不到同链里更早的编辑结果，先人工处理",
    )
    _require_empty(
        f"SELECT id FROM {JOBS} WHERE kind = 'image' AND root_job_id IS NOT NULL",
        "图片记录带着原作号，先人工处理",
    )


def downgrade() -> None:
    """列写回编辑坐标、合成改回 clip 成片，再删列；参考片段不造回。"""

    _require_empty(
        f"""
        SELECT m.id FROM {JOBS} AS m
        WHERE m.operation = 'compose' AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(m.request->'segments') AS s
            WHERE jsonb_typeof(s->'end') IS DISTINCT FROM 'number'
        )
        """,
        "合成里有取到结尾的段，旧形状表达不了，拒绝降级",
    )
    for name, _ in reversed(_CHECKS):
        op.drop_constraint(name, TABLE, type_="check", schema=SCHEMA)
    op.drop_index("ix_generation_jobs_source_job", TABLE, schema=SCHEMA)
    op.drop_constraint("fk_generation_jobs_source_job", TABLE, type_="foreignkey", schema=SCHEMA)
    # 编辑段：editId 就用它自己的 id；基底是一次合成时，baseEdit 写那次合成的来源编辑段的 id，
    # 与下一条语句给合成抄过去的 editId 是同一个值。
    op.execute(
        f"""
        UPDATE {JOBS} AS e
        SET metadata = COALESCE(e.metadata, '{{}}'::jsonb)
            || jsonb_build_object(
                'editId', e.id::text,
                'editStart', e.range_start_ms / 1000.0,
                'editEnd', e.range_end_ms / 1000.0
            )
            || CASE
                WHEN b.operation = 'compose'
                THEN jsonb_build_object('baseEdit', b.source_job_id::text)
                ELSE '{{}}'::jsonb
            END
        FROM {JOBS} AS b
        WHERE b.id = e.source_job_id AND e.kind = 'video' AND e.operation = 'generate'
        """
    )
    op.execute(
        f"""
        UPDATE {JOBS} AS m
        SET kind = 'clip',
            request = (m.request - 'userName') || jsonb_build_object('purpose', 'master'),
            metadata = COALESCE(m.metadata, '{{}}'::jsonb) || jsonb_strip_nulls(
                jsonb_build_object(
                    'editId', e.metadata->'editId',
                    'baseEdit', e.metadata->'baseEdit',
                    'editStart', e.metadata->'editStart',
                    'editEnd', e.metadata->'editEnd'
                )
            )
        FROM {JOBS} AS e
        WHERE e.id = m.source_job_id AND m.operation = 'compose'
        """
    )
    for column in ("range_end_ms", "range_start_ms", "source_job_id", "operation"):
        op.drop_column(TABLE, column, schema=SCHEMA)


def _require_empty(query: str, message: str) -> None:
    found = op.get_bind().execute(sa.text(query)).scalars().all()
    if found:
        raise RuntimeError(f"{message}：{[str(item) for item in found]}")
