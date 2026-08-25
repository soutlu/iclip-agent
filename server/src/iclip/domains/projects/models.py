"""项目的领域模型。

项目是归拢用的口袋：需求单和会话往里放，方便按一摊活找东西。它自己不承载创作事实
——里面装的东西没了它也还在，它没了里面的东西也还在。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True, slots=True)
class Project:
    """一个项目的持久事实行。"""

    id: uuid.UUID
    creator_user_id: uuid.UUID
    """建它的人。项目全公司可见，所以这是查询维度，不是访问边界（同素材账本）。"""
    name: str
    created_at: datetime
    updated_at: datetime


__all__ = ["Project"]
