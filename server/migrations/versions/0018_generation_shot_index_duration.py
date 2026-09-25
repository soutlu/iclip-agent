"""iclip.generation_jobs：视频的镜头组编号与产物时长各落一列，视频的 ``metadata`` 里不再有 ``shot``。

Revision ID: 3403faebf6dc
Revises: 7c50c7336e0c
Create Date: 2026-09-25 18:00:00.000000

过去视频的镜号写在调用方的坐标 ``metadata.shot`` 里，审计与资料库按它数镜；合成量出来的时长
藏在 ``provider_snapshot.durationMs`` 里。现在两者都是系统要读的事实，各做一列：``shot_index``
（镜头组编号）与 ``duration_ms``（产物时长，毫秒），``metadata`` 从此服务端不读不写。图片的
``{shot, frame}`` 只有分镜页自己用来找格子，仍是调用方的标签，一个键不动。

存量先核对，任何一条对不上就带 id 报错、整个迁移回滚：视频带 ``shot`` 键却不是 1..2³¹−1 的
整数、合成快照里的 ``durationMs`` 不是 0..2³¹−1 的整数。然后出片的镜号取自己的 ``metadata.shot``；
编辑段与合成的镜号抄原作的，必须排在前一步之后，链只有一层，一趟就够。擦掉视频行上的 ``shot``
键，合成的时长取自快照，快照本身不改写。最后建（对话，镜号）的部分索引。

不可逆的部分：编辑段与合成在迁移前自带的 ``metadata.shot`` 已按原作覆盖，降级不还原；降级时
出片的 ``metadata.shot`` 由列值写回，0018 之后调用方自己写进出片 ``metadata`` 的 ``shot`` 会被
列值盖掉，列为空的那些降级后又会被当成镜号。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "3403faebf6dc"
down_revision: str | None = "7c50c7336e0c"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "generation_jobs"
JOBS = f"{SCHEMA}.{TABLE}"

_TAKES = "kind = 'video' AND operation = 'generate' AND source_job_id IS NULL"
"""镜号由调用方给的那种行：出片（没有来源的视频 generate）。"""

_INDEX = "ix_generation_jobs_conversation_shot"
_INDEX_WHERE = "kind = 'video' AND shot_index IS NOT NULL"
"""与 ``infra_sql.generation_jobs_table`` 上声明的同名同式。"""


def upgrade() -> None:
    _check_existing_rows()

    op.add_column(TABLE, sa.Column("shot_index", sa.Integer(), nullable=True), schema=SCHEMA)
    op.add_column(TABLE, sa.Column("duration_ms", sa.Integer(), nullable=True), schema=SCHEMA)

    # 核对已保证带键的都是整数；先转 numeric 再转 int：jsonb 里写成 2.0 的，文本形式转不了 int。
    op.execute(
        f"""
        UPDATE {JOBS}
        SET shot_index = (metadata->>'shot')::numeric::int
        WHERE {_TAKES} AND jsonb_exists(metadata, 'shot')
        """
    )
    op.execute(
        f"""
        UPDATE {JOBS} AS e
        SET shot_index = r.shot_index
        FROM {JOBS} AS r
        WHERE r.id = e.root_job_id AND e.kind = 'video'
        """
    )
    op.execute(
        f"""
        UPDATE {JOBS}
        SET metadata = NULLIF(metadata - 'shot', '{{}}'::jsonb)
        WHERE kind = 'video' AND jsonb_exists(metadata, 'shot')
        """
    )
    op.execute(
        f"""
        UPDATE {JOBS}
        SET duration_ms = (provider_snapshot->>'durationMs')::numeric::int
        WHERE operation = 'compose' AND jsonb_exists(provider_snapshot, 'durationMs')
        """
    )

    op.create_index(
        _INDEX,
        TABLE,
        ["conversation_id", "shot_index"],
        schema=SCHEMA,
        postgresql_where=sa.text(_INDEX_WHERE),
    )


def _check_existing_rows() -> None:
    """回填要转成整数的值逐条核对；对不上的不静默丢掉或截断。"""

    # CASE 保证先判类型再转数字：坐标是调用方手写的 JSON，类型不对时不能让整个迁移以转换错误崩掉。
    _require_empty(
        f"""
        SELECT id FROM {JOBS}
        WHERE kind = 'video' AND jsonb_exists(metadata, 'shot')
          AND NOT CASE
              WHEN jsonb_typeof(metadata->'shot') = 'number'
              THEN (metadata->>'shot')::numeric = trunc((metadata->>'shot')::numeric)
               AND (metadata->>'shot')::numeric BETWEEN 1 AND 2147483647
              ELSE false
          END
        """,
        "视频的 metadata.shot 不是正整数，先人工处理",
    )
    _require_empty(
        f"""
        SELECT id FROM {JOBS}
        WHERE operation = 'compose' AND jsonb_exists(provider_snapshot, 'durationMs')
          AND NOT CASE
              WHEN jsonb_typeof(provider_snapshot->'durationMs') = 'number'
              THEN (provider_snapshot->>'durationMs')::numeric
                   = trunc((provider_snapshot->>'durationMs')::numeric)
               AND (provider_snapshot->>'durationMs')::numeric BETWEEN 0 AND 2147483647
              ELSE false
          END
        """,
        "合成快照里的 durationMs 不是非负整数，先人工处理",
    )


def downgrade() -> None:
    """列写回出片的 ``metadata.shot`` 与快照的 ``durationMs``，再删索引与列；编辑段与合成的旧坐标不还原。"""

    op.execute(
        f"""
        UPDATE {JOBS}
        SET metadata = COALESCE(metadata, '{{}}'::jsonb) || jsonb_build_object('shot', shot_index)
        WHERE {_TAKES} AND shot_index IS NOT NULL
        """
    )
    op.execute(
        f"""
        UPDATE {JOBS}
        SET provider_snapshot = COALESCE(provider_snapshot, '{{}}'::jsonb)
            || jsonb_build_object('durationMs', duration_ms)
        WHERE duration_ms IS NOT NULL
        """
    )
    op.drop_index(_INDEX, TABLE, schema=SCHEMA)
    for column in ("duration_ms", "shot_index"):
        op.drop_column(TABLE, column, schema=SCHEMA)


def _require_empty(query: str, message: str) -> None:
    found = op.get_bind().execute(sa.text(query)).scalars().all()
    if found:
        raise RuntimeError(f"{message}：{[str(item) for item in found]}")
