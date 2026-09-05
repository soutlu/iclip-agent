"""媒体生成持久模型。请求类型统一定义于 schemas.py，同时用于 HTTP 与持久化。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final, Literal

from iclip.domains.generation.schemas import GenerationRequest

GenerationKind = Literal["video", "image"]

GenerationStatus = Literal["pending", "submitting", "submitted", "completed", "failed"]
STATUS_PENDING: Final = "pending"
"""已受理，尚未提交给 Provider。"""
STATUS_SUBMITTING: Final = "submitting"
"""提交中断时禁止自动重投，避免重复计费；恢复规则见 queue.py。"""
STATUS_SUBMITTED: Final = "submitted"
"""Provider 已接受任务，等待结果。"""
STATUS_COMPLETED: Final = "completed"
STATUS_FAILED: Final = "failed"

TERMINAL_STATUSES: Final = frozenset({STATUS_COMPLETED, STATUS_FAILED})


@dataclass(frozen=True, slots=True)
class GenerationJob:
    """生成任务持久记录，排期状态由 procrastinate 独立管理。"""

    id: uuid.UUID
    owner_user_id: uuid.UUID
    api_key_id: uuid.UUID | None
    """发起生成时使用的 API key，供审计使用。"""
    kind: GenerationKind
    provider: str
    request: GenerationRequest
    status: GenerationStatus
    provider_task_id: str | None
    provider_status: str | None
    """Provider 原始状态，不映射为内部枚举。"""
    provider_snapshot: dict[str, Any] | None
    """provider 最近一次返回的原始响应，排障用。"""
    output_url: str | None
    error_code: str | None
    error_message: str | None
    created_at: datetime
    updated_at: datetime
    submitted_at: datetime | None
    finished_at: datetime | None
    conversation_id: uuid.UUID | None = None
    """生成来源对话。无对话上下文时为空；不设外键，删除对话后仍保留来源。"""
    shot_index: int | None = None
    """对应 video_shot.json 的镜头组 index；非镜头组生成时为空。"""


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
