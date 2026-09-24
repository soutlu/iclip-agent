"""资料库查询的入口形状：筛选范围与翻页游标。读模型见 schemas.py。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

Orientation = Literal["portrait", "landscape"]
"""画幅朝向，按出片请求里的 ``aspect_ratio`` 判；认不出比例的（如 ``adaptive``）两边都不算。"""


@dataclass(frozen=True, slots=True)
class Scope:
    """一次查询的筛选范围。时间窗 ``[since, until)`` 作用在卡面那条记录的建立时刻上。"""

    user_name: str | None = None
    since: datetime | None = None
    until: datetime | None = None
    orientation: Orientation | None = None
    q: str | None = None
    """关键词，按字面包含匹配卡面那次出片的正文与对话标题，不区分大小写。"""


@dataclass(frozen=True, slots=True)
class VideoCursor:
    """列表的排序键：卡面时刻加卡面那次出片的 id。"""

    at: datetime
    video_id: uuid.UUID


__all__ = ["Orientation", "Scope", "VideoCursor"]
