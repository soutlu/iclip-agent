"""测试库直连与清表。

清表先踢掉握着表锁的遗留会话，再在限时内 TRUNCATE：上一个用例可能留下没关干净的连接
（跨事件循环的 NullPool 连接、被取消在事务中间的运行），它握着的表锁会让 TRUNCATE 无限期
等待，整条 CI 就此挂住。测试库专用，踢掉别的会话不伤人。
"""

from __future__ import annotations

import warnings
from collections.abc import AsyncGenerator, Sequence
from contextlib import asynccontextmanager

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine
from sqlalchemy.pool import NullPool

APP_TABLES = (
    "iclip.users",
    "iclip.oauth_accounts",
    "iclip.api_keys",
    "iclip.conversations",
    "iclip.collections",
    "iclip.tasks",
    "iclip.task_assignees",
    "iclip.generation_jobs",
    "iclip.tracking_events",
)
"""iclip 里每个用例自己造数据的表。``inspiration_videos`` 装着迁移灌入的快照，只由爆款视频夹具清。"""

AGENT_RUNTIME_TABLES = (
    "agent_runtime.runs",
    "agent_runtime.events",
    "agent_runtime.snapshots",
    "agent_runtime.snapshot_idempotency_keys",
    "agent_runtime.tool_effects",
    "agent_runtime.media",
    "agent_runtime.agent_jobs",
    "agent_runtime.agent_job_runs",
    "agent_runtime.conversation_usage",
    "agent_runtime.materials",
    "agent_runtime.workspace_files",
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


async def reset_database(conn: AsyncConnection) -> None:
    """一条语句清空 ``APP_TABLES`` 与 ``AGENT_RUNTIME_TABLES``。

    不带 CASCADE：外键两端都在清单里就不需要级联；新表外键指向清单却没进清单时当场报错。
    """

    await truncate_clean(conn, (*APP_TABLES, *AGENT_RUNTIME_TABLES))


@asynccontextmanager
async def connected(url: str) -> AsyncGenerator[AsyncConnection]:
    """在一次性引擎上开一个事务连接，块正常结束提交、出错回滚，最后释放引擎。

    NullPool 让连接随块关闭，``asyncio.run`` 里用也不会把连接留给下一个事件循环。
    """

    engine = create_async_engine(url, poolclass=NullPool)
    try:
        async with engine.begin() as conn:
            yield conn
    finally:
        await engine.dispose()


__all__ = [
    "AGENT_RUNTIME_TABLES",
    "APP_TABLES",
    "LOCK_TIMEOUT",
    "connected",
    "reset_database",
    "truncate_clean",
]
