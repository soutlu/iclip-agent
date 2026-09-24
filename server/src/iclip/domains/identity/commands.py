"""identity 写侧命令 DTO。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from iclip.domains.identity.rbac import Permission


@dataclass(frozen=True, slots=True)
class CreateApiKey:
    """签发 key；``permissions`` 已是词表内的权限，由请求体校验保证。"""

    name: str
    permissions: frozenset[Permission]
    expires_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class UpdateUser:
    """用户管理面的调整；None 表示不变。``direct_permissions`` 已由请求体按词表校验。"""

    roles: tuple[str, ...] | None = None
    direct_permissions: frozenset[Permission] | None = None
    is_active: bool | None = None


__all__ = ["CreateApiKey", "UpdateUser"]
