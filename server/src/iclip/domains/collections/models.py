"""合集领域模型。对话与合集独立存在；删除合集只清空对话的合集归属。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True, slots=True)
class Collection:
    """合集持久记录。"""

    id: uuid.UUID
    owner_user_id: uuid.UUID
    """用于行级访问控制的属主。"""
    name: str
    created_at: datetime
    updated_at: datetime


__all__ = ["Collection"]
