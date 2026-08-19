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
    """管理员对用户的调整；None 表示不变。"""

    role: str | None = None
    is_active: bool | None = None


__all__ = ["CreateApiKey", "UpdateUser"]
