"""数据库平台原语：行级归属过滤等跨模块复用的 SQL 构件。"""

from __future__ import annotations

from iclip.platform.db.ownership import scope_to_owner

__all__ = ["scope_to_owner"]
