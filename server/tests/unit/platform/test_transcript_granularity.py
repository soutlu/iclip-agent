"""订阅档位的筛法。

这一份是照抄客户端 vendor 的 ``granularity/filterOps.ts``。两边不一样的表现是：客户端等一个
永远不来的操作，界面停住而不报错。所以这里逐档钉住「收哪些、不收哪些」。
"""

from __future__ import annotations

import pytest

from iclip.platform.transcript.granularity import (
    TranscriptGrade,
    filter_ops_for_grade,
    grade_for,
    needs_reset_on_transition,
)
from iclip.platform.transcript.ops import (
    AppendOp,
    EmittableOperation,
    FrameTarget,
    FrameUpsertOp,
    Interaction,
    InteractionUpsertOp,
    StepHeader,
    StepUpsertOp,
    TextContent,
    TextFrame,
    TurnHeader,
    TurnOrigin,
    TurnUpsertOp,
)

BATCH: tuple[EmittableOperation, ...] = (
    TurnUpsertOp(
        turn=TurnHeader(
            turn_id="t1",
            ordinal=1,
            state="running",
            origin=TurnOrigin(kind="user"),
            content=(TextContent(text="走"),),
        )
    ),
    StepUpsertOp(
        turn_id="t1",
        step=StepHeader(step_id="t1.1", turn_id="t1", ordinal=1, state="running"),
    ),
    FrameUpsertOp(
        turn_id="t1",
        step_id="t1.1",
        frame=TextFrame(frame_id="t1.1.f1", role="assistant", text="好"),
    ),
    AppendOp(
        target=FrameTarget(turn_id="t1", step_id="t1.1", frame_id="t1.1.f1"), offset=1, text="的"
    ),
    InteractionUpsertOp(
        interaction=Interaction(
            interaction_id="apr_1", interaction_kind="approval", state="pending"
        )
    ),
)


def _kinds(grade: TranscriptGrade) -> list[str]:
    return [operation.op for operation in filter_ops_for_grade(grade, BATCH)]


def test_off_takes_nothing() -> None:
    assert _kinds("off") == []


def test_turn_keeps_the_turn_and_the_approval_card() -> None:
    """侧栏要的就这两样：跑没跑（轮）、有没有卡在等人点头（审批）。"""

    assert _kinds("turn") == ["turn.upsert", "interaction.upsert"]


def test_block_adds_steps_and_frames_but_not_deltas() -> None:
    assert _kinds("block") == [
        "turn.upsert",
        "step.upsert",
        "frame.upsert",
        "interaction.upsert",
    ]


def test_delta_is_the_identity() -> None:
    """最高档不筛任何东西——下面那条不变量的另一半。"""

    assert filter_ops_for_grade("delta", BATCH) == BATCH


@pytest.mark.parametrize("grade", ["off", "turn", "block"])
def test_only_delta_carries_appends(grade: TranscriptGrade) -> None:
    """``append`` 是唯一不可重放的操作（按 offset 追加），它只在 delta 档留得下来。

    连接层据此敢把「筛空了的批次」整批丢掉：剩下的都是可重复应用的，客户端水位停在原处、
    重连时再收一遍也不会错。往协议里加新操作时这条要重新验。
    """

    assert "append" not in _kinds(grade)


def test_no_grade_means_off_not_everything() -> None:
    """没说要哪一档就是不要。默认「全都要」的话，一个不带档位的客户端会拖着全量流量。"""

    assert grade_for({}, "main") == "off"
    assert grade_for({"*": "turn"}, "main") == "turn"
    assert grade_for({"main": "delta", "*": "turn"}, "main") == "delta"


def test_reset_only_when_the_grade_goes_up() -> None:
    """降档不用重来（粗的那些是细的子集），升档必须重来。"""

    assert needs_reset_on_transition("turn", "delta")
    assert not needs_reset_on_transition("delta", "turn")
    assert not needs_reset_on_transition("delta", "delta")
