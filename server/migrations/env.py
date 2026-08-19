"""Alembic 环境：URL 来自 attributes（测试程序化注入优先）或 ICLIP_DATABASE_URL。"""

from __future__ import annotations

import asyncio
import os

from alembic import context
from sqlalchemy import text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import create_async_engine

from iclip.domains.identity.infra_sql import DB_SCHEMA, Base

target_metadata = Base.metadata


def _database_url() -> str:
    url = context.config.attributes.get("sqlalchemy_url") or os.environ.get(
        "ICLIP_DATABASE_URL", ""
    )
    if not url:
        raise RuntimeError("缺少数据库连接串：attributes['sqlalchemy_url'] 或 ICLIP_DATABASE_URL")
    return url


def _run_migrations(connection: Connection) -> None:
    connection.execute(text(f"CREATE SCHEMA IF NOT EXISTS {DB_SCHEMA}"))
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        version_table_schema=DB_SCHEMA,
        include_schemas=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def _run_async() -> None:
    engine = create_async_engine(_database_url())
    try:
        async with engine.connect() as connection:
            await connection.run_sync(_run_migrations)
            await connection.commit()
    finally:
        await engine.dispose()


def _run() -> None:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(_run_async())
        return
    # 已在事件循环内（如异步测试进程）：另起线程独立跑一个 loop。
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=1) as pool:
        pool.submit(asyncio.run, _run_async()).result()


if context.is_offline_mode():
    raise RuntimeError("不支持 offline 模式：迁移必须在真实数据库上执行")

_run()
