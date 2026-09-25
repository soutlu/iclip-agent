"""iclip.generation_jobs：分叉副本里拷来的出片记录并回源记录，副本改为按血缘继承。

Revision ID: 2f9ffd7b9bbe
Revises: 44301a1420de
Create Date: 2026-09-24 18:00:00.000000

分叉过去会把源对话已完成的出片连同编辑链整份拷进副本：换新 id、原作号换成副本里的新根、
地址与时间戳原样。现在副本按血缘读源的记录，拷贝就成了同一件事实的第二份。

认副本：记录所在对话是分叉来的，且记录早于那段对话建立——拷贝保留源的时间戳，副本自己
出的都晚于它。找源：沿所在对话的来源链往上，地址相同、自身不是副本的那条；每条副本必须
恰好一条，否则带 id 报错终止。副本里原生记录的原作号与指向副本的下载事件先改指源，再一条
语句删掉全部副本（副本之间的原作号引用随同一条语句一起消失，外键在语句末尾才检查）。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "2f9ffd7b9bbe"
down_revision: str | None = "44301a1420de"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
JOBS = f"{SCHEMA}.generation_jobs"
CONVERSATIONS = f"{SCHEMA}.conversations"
EVENTS = f"{SCHEMA}.tracking_events"


def upgrade() -> None:
    # 副本与它的源对照表：找不到源的副本 source_id 为空，找到多条的每条一行，下面一起拦。
    op.execute(
        f"""
        CREATE TEMP TABLE fork_copies ON COMMIT DROP AS
        WITH RECURSIVE lineage AS (
            SELECT c.id AS conversation_id, c.forked_from AS ancestor_id
            FROM {CONVERSATIONS} AS c
            WHERE c.forked_from IS NOT NULL
            UNION ALL
            SELECT l.conversation_id, a.forked_from
            FROM lineage AS l
            JOIN {CONVERSATIONS} AS a ON a.id = l.ancestor_id
            WHERE a.forked_from IS NOT NULL
        ),
        copies AS (
            SELECT g.id, g.conversation_id, g.output_url
            FROM {JOBS} AS g
            JOIN {CONVERSATIONS} AS c ON c.id = g.conversation_id
            WHERE c.forked_from IS NOT NULL AND g.created_at < c.created_at
        )
        SELECT cp.id AS copy_id, src.id AS source_id
        FROM copies AS cp
        LEFT JOIN LATERAL (
            SELECT s.id
            FROM lineage AS l
            JOIN {JOBS} AS s
              ON s.conversation_id = l.ancestor_id AND s.output_url = cp.output_url
            JOIN {CONVERSATIONS} AS sc ON sc.id = s.conversation_id
            WHERE l.conversation_id = cp.conversation_id
              AND (sc.forked_from IS NULL OR s.created_at >= sc.created_at)
        ) AS src ON true
        """
    )
    _require_empty(
        "SELECT copy_id FROM fork_copies GROUP BY copy_id HAVING count(source_id) <> 1",
        "分叉副本里的记录在来源链上找不到唯一一条源记录，先人工处理",
    )
    # 留下来的记录凡是原作号指着副本的（副本里原生的编辑结果与成片），改指副本的源。
    op.execute(
        f"""
        UPDATE {JOBS} AS g
        SET root_job_id = f.source_id
        FROM fork_copies AS f
        WHERE g.root_job_id = f.copy_id
          AND g.id NOT IN (SELECT copy_id FROM fork_copies)
        """
    )
    # 在副本里下载的是拷贝，事实上下载的是源那条；审计按它推回镜。
    op.execute(
        f"""
        UPDATE {EVENTS} AS t
        SET job_id = f.source_id
        FROM fork_copies AS f
        WHERE t.job_id = f.copy_id
        """
    )
    op.execute(f"DELETE FROM {JOBS} WHERE id IN (SELECT copy_id FROM fork_copies)")
    op.execute("DROP TABLE fork_copies")


def downgrade() -> None:
    """删掉的是分叉拷进副本的第二份，降级不把它造回来；改指源的原作号与下载事件也不改回去。"""


def _require_empty(query: str, message: str) -> None:
    found = op.get_bind().execute(sa.text(query)).scalars().all()
    if found:
        raise RuntimeError(f"{message}：{[str(item) for item in found]}")
