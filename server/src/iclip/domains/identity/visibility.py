"""读取范围：主体能看到谁的记录。返回值直接作仓库的 ``owner=`` 过滤条件，``None`` 表示不限属主。"""

from __future__ import annotations

import uuid

from iclip.domains.identity.models import Principal
from iclip.domains.identity.rbac import ACT_AS_PERMISSION, MANAGE_PERMISSION


def visible_owner(principal: Principal) -> uuid.UUID | None:
    """治理者不限属主，其余主体只看自己的。"""

    return None if principal.has(MANAGE_PERMISSION) else principal.user_id


def visible_owner_incl_act_as(principal: Principal) -> uuid.UUID | None:
    """在 ``visible_owner`` 之上，持 ``users:act_as`` 的钥匙也不限属主。

    只看钥匙：用户账号即使被授予 ``users:act_as`` 也替不了人，读取范围不跟着放开。
    """

    if principal.kind == "api_key" and principal.has(ACT_AS_PERMISSION):
        return None
    return visible_owner(principal)


__all__ = ["visible_owner", "visible_owner_incl_act_as"]
