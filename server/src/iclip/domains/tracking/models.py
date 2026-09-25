"""埋点事件的领域形状：封闭的事件名表与落表的一条事实。术语见 docs/CONTEXT.md「埋点事件」。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Final, Literal

EventName = Literal["video.downloaded"]
"""事件名表。每个事件名必带哪个主语由服务层规定，加事件名要同时补上那条规则。"""

VIDEO_DOWNLOADED: Final = "video.downloaded"
"""有人下载了一条可下载的视频；主语是那条生成记录。"""


@dataclass(frozen=True, slots=True)
class TrackingEvent:
    """待落表的一条事件。发起用户与 API key 取自主体，发生时刻由数据库在插入时给。"""

    name: EventName
    job_id: uuid.UUID | None
    conversation_id: uuid.UUID | None
    user_id: uuid.UUID
    api_key_id: uuid.UUID | None


__all__ = ["VIDEO_DOWNLOADED", "EventName", "TrackingEvent"]
