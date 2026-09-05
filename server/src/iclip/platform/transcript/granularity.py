"""按 subscribe_v2 的 agent 粒度筛选操作，与客户端 granularity/filterOps.ts 和 grade.ts 一致。

off 仅停止发送操作，仍保留监听和实时状态引用；释放资源需要退订。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Final, Literal

from iclip.platform.transcript.ops import EmittableOperation

TranscriptGrade = Literal["off", "turn", "block", "delta"]

GRADE_RANK: Final[Mapping[TranscriptGrade, int]] = {
    "off": 0,
    "turn": 1,
    "block": 2,
    "delta": 3,
}


def grade_for(spec: Mapping[str, TranscriptGrade], agent_id: str) -> TranscriptGrade:
    """返回 agent 的订阅粒度；未指定时为 off。"""

    return spec.get(agent_id) or spec.get("*") or "off"


def admits(grade: TranscriptGrade, operation: EmittableOperation) -> bool:
    """按粒度筛选操作细节；轮、任务、prompt、审批、meta 和删除在非 off 档保留。"""

    if operation.op == "append":
        return GRADE_RANK[grade] >= GRADE_RANK["delta"]
    if operation.op in ("step.upsert", "frame.upsert"):
        return GRADE_RANK[grade] >= GRADE_RANK["block"]
    return True


def filter_ops_for_grade(
    grade: TranscriptGrade, ops: Sequence[EmittableOperation]
) -> tuple[EmittableOperation, ...]:
    """筛选操作，空结果不发送批次。

    append 仅属于 delta，且 delta 不筛选操作；较低粒度的保留操作须可重复应用，
    以保证客户端水位停留后重连补发安全。
    """

    if GRADE_RANK[grade] == 0:
        return ()
    return tuple(operation for operation in ops if admits(grade, operation))


def needs_reset_on_transition(previous: TranscriptGrade, current: TranscriptGrade) -> bool:
    """升档需要 reset，以恢复低粒度期间过滤掉的内容。"""

    return GRADE_RANK[current] > GRADE_RANK[previous]


__all__ = [
    "GRADE_RANK",
    "TranscriptGrade",
    "admits",
    "filter_ops_for_grade",
    "grade_for",
    "needs_reset_on_transition",
]
