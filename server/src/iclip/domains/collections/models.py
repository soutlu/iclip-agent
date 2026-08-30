"""合集的领域模型。

合集是归拢对话用的口袋：一段对话至多待在一个合集里，随时能换、能拿出来。它自己不
承载创作事实——里面装的对话没了它也还在，它没了对话也还在。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True, slots=True)
class Collection:
    """一个合集的持久事实行。"""

    id: uuid.UUID
    owner_user_id: uuid.UUID
    """归谁。合集只对属主可见，所以这一列是访问边界，不只是查询维度。"""
    name: str
    created_at: datetime
    updated_at: datetime


__all__ = ["Collection"]
