"""iclip.generation_jobs：编辑坐标里「基于哪一版」从记录 id 改成那一版的 editId。

Revision ID: 3f8d27c1a5e9
Revises: b6e2f4a9c713
Create Date: 2026-09-22 14:00:00.000000

便签里不放记录 id：分叉把整条链拷进副本并换新 id，写着记录 id 的 ``baseJob``
会随之失效。存量按 ``baseJob`` 指向谁改写：指向根（独立记录）就是基于原片，键直接擦掉；
指向某条成片就写成那条成片的 ``editId``。对不上的行带 id 报错终止，不静默留成基于原片。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "3f8d27c1a5e9"
down_revision: str | None = "b6e2f4a9c713"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "generation_jobs"


def upgrade() -> None:
    _require_empty(
        f"""
        SELECT g.id FROM {SCHEMA}.{TABLE} AS g
        LEFT JOIN {SCHEMA}.{TABLE} AS t ON t.id::text = g.metadata->>'baseJob'
        WHERE jsonb_exists(g.metadata, 'baseJob') AND t.id IS NULL
        """,
        "baseJob 指向不存在的记录，先人工处理",
    )
    _require_empty(
        f"""
        SELECT g.id FROM {SCHEMA}.{TABLE} AS g
        JOIN {SCHEMA}.{TABLE} AS t ON t.id::text = g.metadata->>'baseJob'
        WHERE t.root_job_id IS NOT NULL AND NOT jsonb_exists(t.metadata, 'editId')
        """,
        "baseJob 指向的成片没有 editId，先人工处理",
    )
    # 指向根的：基于原片，不写；指向成片的：写那条成片的 editId。擦成空对象的整张置空。
    op.execute(
        f"""
        UPDATE {SCHEMA}.{TABLE} AS g
        SET metadata = NULLIF(
            (g.metadata - 'baseJob') || CASE
                WHEN t.root_job_id IS NULL THEN '{{}}'::jsonb
                ELSE jsonb_build_object('baseEdit', t.metadata->>'editId')
            END,
            '{{}}'::jsonb
        )
        FROM {SCHEMA}.{TABLE} AS t
        WHERE jsonb_exists(g.metadata, 'baseJob') AND t.id::text = g.metadata->>'baseJob'
        """
    )


_MASTER_OF_BASE_EDIT = f"""
    SELECT m.id::text FROM {SCHEMA}.{TABLE} AS m
    WHERE m.root_job_id = g.root_job_id
      AND m.kind = 'clip' AND m.request->>'purpose' = 'master'
      AND m.metadata->>'editId' = g.metadata->>'baseEdit'
    LIMIT 1
"""
"""同链里 ``baseEdit`` 指的那条成片的 id；相关子查询，外层别名必须叫 ``g``。"""


def downgrade() -> None:
    """把 editId 换回记录 id：有 baseEdit 的写同链里同 editId 的成片，没有的基于原片就写根。

    只对完整的链精确：分叉副本里的行升级时已按新根改写，降级写回的是新根的 id，不是源对话的。
    """

    _require_empty(
        f"""
        SELECT g.id FROM {SCHEMA}.{TABLE} AS g
        WHERE jsonb_exists(g.metadata, 'baseEdit') AND ({_MASTER_OF_BASE_EDIT}) IS NULL
        """,
        "baseEdit 找不到同链里的成片，先人工处理",
    )
    op.execute(
        f"""
        UPDATE {SCHEMA}.{TABLE} AS g
        SET metadata = (g.metadata - 'baseEdit') || jsonb_build_object(
            'baseJob',
            CASE
                WHEN jsonb_exists(g.metadata, 'baseEdit') THEN ({_MASTER_OF_BASE_EDIT})
                ELSE g.root_job_id::text
            END
        )
        WHERE g.root_job_id IS NOT NULL AND jsonb_exists(g.metadata, 'editId')
        """
    )


def _require_empty(query: str, message: str) -> None:
    found = op.get_bind().execute(sa.text(query)).scalars().all()
    if found:
        raise RuntimeError(f"{message}：{[str(item) for item in found]}")
