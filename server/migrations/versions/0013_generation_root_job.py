"""iclip.generation_jobs：衍生记录的原作号从便签升为列。

Revision ID: b6e2f4a9c713
Revises: 5a9c2e17bd48
Create Date: 2026-09-22 10:00:00.000000

视频编辑的参考片段、编辑结果与成片此前在 ``metadata.rootJob`` 里手写最初那条出片的 id，
审计与分叉拷贝都靠读这个键判「这是衍生记录」。现在它是一列自引用外键：空即独立记录，
非空指向同一段对话里的一条独立记录，链只有一层。存量照抄进列，再从便签上擦掉。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b6e2f4a9c713"
down_revision: str | None = "5a9c2e17bd48"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "generation_jobs"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("root_job_id", sa.Uuid(), nullable=True), schema=SCHEMA)
    op.create_foreign_key(
        "fk_generation_jobs_root_job",
        TABLE,
        TABLE,
        ["root_job_id"],
        ["id"],
        source_schema=SCHEMA,
        referent_schema=SCHEMA,
    )
    op.create_index(
        "ix_generation_jobs_root_job",
        TABLE,
        ["root_job_id"],
        schema=SCHEMA,
        postgresql_where=sa.text("root_job_id IS NOT NULL"),
    )

    # 便签上的 rootJob 照抄进列，只抄能对上一条真实记录的。按文本比对，不 cast：
    # 便签里手写的非 uuid 值不该让整个迁移以类型错误崩掉，而要落到下面点名的检查里。
    op.execute(
        f"""
        UPDATE {SCHEMA}.{TABLE} AS g
        SET root_job_id = r.id
        FROM {SCHEMA}.{TABLE} AS r
        WHERE jsonb_exists(g.metadata, 'rootJob')
          AND r.id::text = g.metadata->>'rootJob'
        """
    )
    # 对不上号的不能静默留成独立记录，那会让它们进审计、进分叉拷贝；在这里带 id 报错。
    _require_empty(
        f"""
        SELECT id FROM {SCHEMA}.{TABLE}
        WHERE jsonb_exists(metadata, 'rootJob') AND root_job_id IS NULL
        """,
        "rootJob 指向不存在的记录，先人工处理",
    )
    # 原作号只能指独立记录。前端一直只写根，这里核对而不是修正。
    _require_empty(
        f"""
        SELECT g.id FROM {SCHEMA}.{TABLE} AS g
        JOIN {SCHEMA}.{TABLE} AS r ON r.id = g.root_job_id
        WHERE r.root_job_id IS NOT NULL
        """,
        "原作号指向了衍生记录，先人工处理",
    )
    # 本地加工的产物一律是衍生记录；没原作号的 clip 会被当成独立记录，同样在这里拦住。
    _require_empty(
        f"SELECT id FROM {SCHEMA}.{TABLE} WHERE kind = 'clip' AND root_job_id IS NULL",
        "clip 记录没有原作号，先人工处理",
    )
    # 便签上擦掉 rootJob；擦成空对象的整张置空（与 0012 同一写法）。
    op.execute(
        f"""
        UPDATE {SCHEMA}.{TABLE}
        SET metadata = NULLIF(metadata - 'rootJob', '{{}}'::jsonb)
        WHERE jsonb_exists(metadata, 'rootJob')
        """
    )


def downgrade() -> None:
    """把列写回便签再删列。"""

    op.execute(
        f"""
        UPDATE {SCHEMA}.{TABLE}
        SET metadata = COALESCE(metadata, '{{}}'::jsonb)
                       || jsonb_build_object('rootJob', root_job_id::text)
        WHERE root_job_id IS NOT NULL
        """
    )
    op.drop_index("ix_generation_jobs_root_job", TABLE, schema=SCHEMA)
    op.drop_constraint("fk_generation_jobs_root_job", TABLE, type_="foreignkey", schema=SCHEMA)
    op.drop_column(TABLE, "root_job_id", schema=SCHEMA)


def _require_empty(query: str, message: str) -> None:
    found = op.get_bind().execute(sa.text(query)).scalars().all()
    if found:
        raise RuntimeError(f"{message}：{[str(item) for item in found]}")
