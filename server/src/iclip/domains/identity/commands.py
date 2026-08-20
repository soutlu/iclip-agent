"""identity 写侧命令 DTO。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True, slots=True)
class CreateApiKey:
    name: str
    permissions: frozenset[str]
    expires_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class UpdateUser:
    """用户管理面的调整；None 表示不变。"""

    roles: tuple[str, ...] | None = None
    direct_permissions: frozenset[str] | None = None
    is_active: bool | None = None


__all__ = ["CreateApiKey", "UpdateUser"]
