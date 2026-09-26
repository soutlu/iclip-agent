"""媒体生成持久模型。请求类型与状态词统一定义于 schemas.py，同时用于 HTTP 与持久化。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final, Literal

from iclip.domains.generation.schemas import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_SUBMITTED,
    STATUS_SUBMITTING,
    GenerationKind,
    GenerationOperation,
    GenerationRequest,
    GenerationStatus,
)

TERMINAL_STATUSES: Final = frozenset({STATUS_COMPLETED, STATUS_FAILED})

InFlightPhase = Literal["queued", "running"]
"""一批还没跑完的任务给人看的阶段：全在本系统排队是 queued，有一条已交给上游就是 running。"""

Inheritance = Sequence[tuple[uuid.UUID, datetime]]
"""一段对话经分叉继承的边界对：沿分叉来源往上的每个祖先，配上这条链上它的下一级对话的
建立时刻。祖先名下已完成、完成时刻不晚于边界的记录归这段对话继承。"""


@dataclass(frozen=True, slots=True)
class GenerationJob:
    """生成任务持久记录，排期状态由 procrastinate 独立管理。"""

    id: uuid.UUID
    owner_user_id: uuid.UUID
    api_key_id: uuid.UUID | None
    """发起生成时使用的 API key，供审计使用。"""
    kind: GenerationKind
    operation: GenerationOperation
    """怎么执行：调模型、本地拼接、本地切图或用户上传。与 kind、有没有来源一起决定这一行是哪种记录。"""
    provider: str
    request: GenerationRequest | None
    """发给执行方的输入；切图与上传没有，为空。"""
    status: GenerationStatus
    provider_task_id: str | None
    provider_status: str | None
    """Provider 原始状态，不映射为内部枚举。"""
    output_url: str | None
    error_code: str | None
    error_message: str | None
    created_at: datetime
    submitted_at: datetime | None
    finished_at: datetime | None
    conversation_id: uuid.UUID | None = None
    """生成来源对话。无对话上下文时为空；不设外键，删除对话后仍保留来源。"""
    metadata: dict[str, Any] | None = None
    """调用方自己的键（分镜页给图片记 ``{"shot", "frame"}``）；服务端不读不写、不校验，原样存取。"""
    task_id: uuid.UUID | None = None
    """需求单 id，调用方给的归属标签；不设外键，只做筛选。"""
    shot_index: int | None = None
    """镜头组编号，只有视频有：出片由调用方给，可空；编辑段与合成抄原作的。"""
    root_job_id: uuid.UUID | None = None
    """原作：编辑段与合成都指最初那条出片，不管基于哪一版，所以链只有一层；出片自己为空。

    原作用于血缘与没有镜号时的分组（ADR-0002）。在分叉副本里剪继承来的出片，原作照样指源对话里那条。"""
    source_job_id: uuid.UUID | None = None
    """直接来源：编辑段指它的基底成片，合成指它的编辑段，帧图编辑指底图那一条，切图指它的宫格；
    出片、图片生成与上传为空。可以指继承来的记录。"""
    source_url: str | None = None
    """帧图编辑的外部底图地址，与 ``source_job_id`` 恰好一个；其余行为空。"""
    range_start_ms: int | None = None
    range_end_ms: int | None = None
    """编辑段在基底上改的那一段，毫秒；只有编辑段有。受理时是请求的区间，切出参考片段后改记实际切点。"""
    watermark_output_url: str | None = None
    """视频成功时上游发布的水印版地址；图片没有这一份。"""
    duration_ms: int | None = None
    """产物实际多长，毫秒；只有本系统自己加工、量过的（合成）才有，完成时写入。"""


def inherited_through(job: GenerationJob, inheritance: Inheritance) -> bool:
    """这条记录是否经这组边界对继承而来。

    与仓储按对话读记录时的继承分支是同一条规则；受理时核对来源靠它区分「祖先对话里的」
    与「继承来的」——同一个人在源对话里分叉之后才完成的出片，按属主读得到却不归副本。"""

    if job.status != STATUS_COMPLETED or job.finished_at is None:
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
    "GenerationOperation",
    "GenerationStatus",
    "InFlightPhase",
    "Inheritance",
    "inherited_through",
]
