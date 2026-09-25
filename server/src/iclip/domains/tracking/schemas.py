"""埋点端点的请求体，camelCase 别名。"""

from __future__ import annotations

import uuid

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from iclip.domains.tracking.models import EventName


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class TrackingEventIn(CamelModel):
    """一条事件。主语按事件名规定：``video.downloaded`` 必带 ``jobId``、不带 ``conversationId``。"""

    name: EventName
    job_id: uuid.UUID | None = None
    conversation_id: uuid.UUID | None = None


__all__ = ["TrackingEventIn"]
