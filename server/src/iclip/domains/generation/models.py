"""媒体生成持久模型。请求类型与状态词统一定义于 schemas.py，同时用于 HTTP 与持久化。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final, Literal

from iclip.domains.generation.schemas import (
    CLIP_REFERENCE,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_SUBMITTED,
    STATUS_SUBMITTING,
    ClipIn,
    GenerationKind,
    GenerationRequest,
    GenerationStatus,
)

TERMINAL_STATUSES: Final = frozenset({STATUS_COMPLETED, STATUS_FAILED})

InFlightPhase = Literal["queued", "running"]
"""一批还没跑完的任务给人看的阶段：全在本系统排队是 queued，有一条已交给上游就是 running。"""

Inheritance = Sequence[tuple[uuid.UUID, datetime]]
"""一段对话经分叉继承的边界对：沿分叉来源往上的每个祖先，配上这条链上它的下一级对话的
建立时刻。祖先名下已完成、不是参考片段、完成时刻不晚于边界的记录归这段对话继承。"""


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
    metadata: dict[str, Any] | None = None
    """调用方自带的坐标标签（分镜页写 ``{"shot", "frame"}``）。服务端只认 ``shot`` 一个键，
    审计按它数镜；其余键不读、不校验。"""
    task_id: uuid.UUID | None = None
    """需求单 id，调用方给的归属标签；不设外键，只做筛选。"""
    root_job_id: uuid.UUID | None = None
    """原作号：衍生记录指向它所属的那条独立记录，空即独立记录。

    视频编辑的参考片段、编辑结果与成片都写最初那条出片，不写各自基于的版本，所以链只有
    一层，``root_job_id = A`` 就是 A 名下的全部衍生记录。衍生记录不计审计口径；在分叉副本里
    剪继承来的出片，原作号照样指源对话里那条。"""
    watermark_output_url: str | None = None
    """视频成功时上游发布的水印版地址；图片没有这一份。"""


def inherited_through(job: GenerationJob, inheritance: Inheritance) -> bool:
    """这条记录是否经这组边界对继承而来。

    与仓储按对话读记录时的继承分支是同一条规则；受理时核对原作号靠它区分「祖先对话里的」
    与「继承来的」——同一个人在源对话里分叉之后才完成的出片，按属主读得到却不归副本。"""

    if job.status != STATUS_COMPLETED or job.finished_at is None:
        return False
    if isinstance(job.request, ClipIn) and job.request.purpose == CLIP_REFERENCE:
        return False
    return any(
        job.conversation_id == ancestor and job.finished_at <= boundary
        for ancestor, boundary in inheritance
    )


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
    "InFlightPhase",
    "Inheritance",
    "inherited_through",
]
