"""订阅档位：这一档要哪些操作。

侧栏要同时盯好几段对话，但只有打开那一段需要逐字。协议的旋钮就是档位：客户端在
``subscribe_v2`` 里按 agent 给一档，服务端照它筛掉不要的操作。

档位管的是「发多少」，不是「占多少」：``off`` 档的订阅照样挂监听、照样把那段对话钉在实时状态
里（档位是按 agent 的，退订是整段对话的事）。要省资源就退订，不是调 ``off``。

**这是照抄面**，语义逐条对应客户端 vendor 的 ``granularity/filterOps.ts`` 与 ``grade.ts``
（那份是源，改动先看它）。两边只要有一处不一样，客户端就会按自己那份的预期去等一个永远不来的
操作，界面停住而不报错——``test_transcript_granularity`` 就是这条的报警器。
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
    """这个 agent 要哪一档。**没说就是 ``off``**，不是「全都要」。"""

    return spec.get(agent_id) or spec.get("*") or "off"


def admits(grade: TranscriptGrade, operation: EmittableOperation) -> bool:
    """这一档收不收这个操作。

    默认放行（轮、prompt、附件、审批、meta、删除）：档位管的是「细到什么程度」，不是「哪些
    实体」。所以 ``turn`` 档也拿得到审批卡——侧栏据此显示「这段卡在等人点头」。
    """

    if operation.op == "append":
        return GRADE_RANK[grade] >= GRADE_RANK["delta"]
    if operation.op in ("step.upsert", "frame.upsert"):
        return GRADE_RANK[grade] >= GRADE_RANK["block"]
    return True


def filter_ops_for_grade(
    grade: TranscriptGrade, ops: Sequence[EmittableOperation]
) -> tuple[EmittableOperation, ...]:
    """按档位筛一批操作。筛空了调用方就整批不发。

    **不变量：``append`` 是唯一不可重放的操作（它按 offset 往块尾追加），而它只在 ``delta``
    档留得下来；``delta`` 档又不筛任何东西。** 所以筛过的批次一定只剩可重复应用的操作，整批
    被丢掉、客户端水位停在原处、重连时把这几批再收一遍也不会错。往这里加新操作类型时，先确认
    它可重放，否则这条推理断掉，而断掉的表现是刷新前后内容不一致，不报错。
    """

    if GRADE_RANK[grade] == 0:
        return ()
    return tuple(operation for operation in ops if admits(grade, operation))


def needs_reset_on_transition(previous: TranscriptGrade, current: TranscriptGrade) -> bool:
    """档位升高了吗？升高就得整份换掉。

    细的那些操作客户端从来没收到过，补批也补不出来（那几批早就被筛空丢了）。
    """

    return GRADE_RANK[current] > GRADE_RANK[previous]


__all__ = [
    "GRADE_RANK",
    "TranscriptGrade",
    "admits",
    "filter_ops_for_grade",
    "grade_for",
    "needs_reset_on_transition",
]
