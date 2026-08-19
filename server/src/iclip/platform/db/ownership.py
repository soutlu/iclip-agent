"""行级归属收敛的统一原语（防 IDOR）。

``owner=None`` 表示 manager 视角：不加过滤。所有按属主过滤的查询必须
经过这里，禁止各处手写 where 条件。
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import ColumnElement, Select
from sqlalchemy.orm import QueryableAttribute


def scope_to_owner[S: Select[Any]](
    stmt: S,
    column: ColumnElement[uuid.UUID] | QueryableAttribute[uuid.UUID],
    owner: uuid.UUID | None,
) -> S:
    """按属主收敛查询；manager（owner=None）不过滤。"""

    if owner is None:
        return stmt
    return stmt.where(column == owner)  # type: ignore[return-value]


__all__ = ["scope_to_owner"]
