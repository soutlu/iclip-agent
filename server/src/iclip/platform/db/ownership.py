"""行级归属收敛的统一原语（防 IDOR）。

``owner=None`` 是治理者视角：不加属主条件。这条语义只在本模块实现一次，调用方按
手头有什么选形态——已经攒了一串 where 条件的用 ``owner_conditions``，手上是整条
查询的用 ``scope_to_owner``。

``owner`` 可不可空由业务定，与读写无关：治理者能改名、能删除的（合集），写语句
一起走这里；治理者只能看不能改的（对话），写方法就把 ``owner`` 声明成必填，靠签
名挡住传空。
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import ColumnElement, Select
from sqlalchemy.orm import QueryableAttribute


def owner_conditions(
    column: ColumnElement[uuid.UUID] | QueryableAttribute[uuid.UUID],
    owner: uuid.UUID | None,
) -> list[ColumnElement[bool]]:
    """属主条件，拼进调用方已有的 where 列表；治理者拿到空列表。"""

    if owner is None:
        return []
    return [column == owner]


def scope_to_owner[S: Select[Any]](
    stmt: S,
    column: ColumnElement[uuid.UUID] | QueryableAttribute[uuid.UUID],
    owner: uuid.UUID | None,
) -> S:
    """按属主收敛整条查询；治理者不过滤。"""

    return stmt.where(*owner_conditions(column, owner))  # type: ignore[return-value]


__all__ = ["owner_conditions", "scope_to_owner"]
