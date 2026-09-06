"""测试库清表：先踢掉握着表锁的遗留会话，再在限时内 TRUNCATE。

上一个用例可能留下没关干净的连接（跨事件循环的 NullPool 连接、被取消在事务中间的运行）；
它握着的表锁会让 TRUNCATE 无限期等待，整条 CI 就此挂住。测试库专用，踢掉别的会话不伤人。
"""

from __future__ import annotations

import warnings
from collections.abc import Sequence

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

IDENTITY_TABLES = ("iclip.api_keys", "iclip.oauth_accounts", "iclip.users")

AGENT_RUNTIME_TABLES = (
    "agent_runtime.runs",
    "agent_runtime.events",
    "agent_runtime.snapshots",
    "agent_runtime.tool_effects",
    "agent_runtime.media",
    "agent_runtime.agent_jobs",
    "agent_runtime.agent_job_runs",
)

LOCK_TIMEOUT = "10s"
"""TRUNCATE 等锁的上限。等不到就报错并列出阻塞方，不让 CI 挂死。"""


async def truncate_clean(
    conn: AsyncConnection, tables: Sequence[str], *, cascade: bool = False
) -> None:
    """清空 ``tables``；表名是测试代码里的常量，不来自外部输入。"""

    holders = (
        await conn.execute(
            text(
                "SELECT DISTINCT l.pid, a.state, left(a.query, 160) AS query "
                "FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid "
                "WHERE l.locktype = 'relation' AND l.pid <> pg_backend_pid() "
                "AND l.relation = ANY(CAST(:tables AS text[])::regclass[])"
            ),
            {"tables": list(tables)},
        )
    ).all()
    for pid, state, query in holders:
        await conn.execute(text("SELECT pg_terminate_backend(:pid)"), {"pid": pid})
        warnings.warn(
            f"上一个用例遗留的数据库会话（pid={pid}，state={state!r}）还握着表锁，已踢掉；"
            f"它当时在跑：{query}",
            stacklevel=2,
        )
    await conn.execute(text(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'"))
    await conn.execute(text(f"TRUNCATE {', '.join(tables)}{' CASCADE' if cascade else ''}"))


__all__ = ["AGENT_RUNTIME_TABLES", "IDENTITY_TABLES", "LOCK_TIMEOUT", "truncate_clean"]
