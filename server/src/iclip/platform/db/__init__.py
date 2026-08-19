"""数据库平台句柄。

组合根构造引擎并注入 ``Database``；业务模块只接收该句柄，
不读连接串、不判 driver。
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from iclip.platform.db.ownership import scope_to_owner


@dataclass(frozen=True, slots=True)
class Database:
    """每 worker 一份的引擎与会话工厂。"""

    engine: AsyncEngine
    session_factory: async_sessionmaker[AsyncSession]


__all__ = ["Database", "scope_to_owner"]
