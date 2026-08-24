"""媒体生成的领域模型：一次生成这一路的状态。

请求参数本身在 [schemas.py](schemas.py) —— 它既是对外的 wire 形状也是入库形状，
一套定义，不在这里再写一遍。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final, Literal

from iclip.domains.generation.schemas import GenerationRequest

GenerationKind = Literal["video", "image"]

GenerationStatus = Literal["pending", "submitting", "submitted", "completed", "failed"]
STATUS_PENDING: Final = "pending"
"""已受理，还没提交给 provider。"""
STATUS_SUBMITTING: Final = "submitting"
"""正在提交。落在这个状态上的行不允许自动重投——见 ``queue.py``。"""
STATUS_SUBMITTED: Final = "submitted"
"""provider 已收下，等它出结果。"""
STATUS_COMPLETED: Final = "completed"
STATUS_FAILED: Final = "failed"

TERMINAL_STATUSES: Final = frozenset({STATUS_COMPLETED, STATUS_FAILED})


@dataclass(frozen=True, slots=True)
class GenerationJob:
    """一次生成的持久事实行。

    这里没有任何排期字段（下次几点做、试了几次、谁在处理）：那些在 procrastinate 自
    己的表里，见 ``queue.py``。
    """

    id: uuid.UUID
    owner_user_id: uuid.UUID
    api_key_id: uuid.UUID | None
    """经 API key 发起时记下是哪把 key 干的（可审计）。"""
    kind: GenerationKind
    provider: str
    request: GenerationRequest
    status: GenerationStatus
    provider_task_id: str | None
    provider_status: str | None
    """provider 侧的原始状态字符串，原样存着，不映射成自己的枚举。"""
    provider_snapshot: dict[str, Any] | None
    """provider 最近一次返回的原始响应，排障用。"""
    output_url: str | None
    error_code: str | None
    error_message: str | None
    created_at: datetime
    updated_at: datetime
    submitted_at: datetime | None
    finished_at: datetime | None


__all__ = [
    "STATUS_COMPLETED",
    "STATUS_FAILED",
    "STATUS_PENDING",
    "STATUS_SUBMITTED",
    "STATUS_SUBMITTING",
    "TERMINAL_STATUSES",
    "GenerationJob",
    "GenerationKind",
    "GenerationStatus",
]
