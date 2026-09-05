"""验证服务端订阅粒度与客户端 granularity/filterOps.ts 的操作筛选一致。"""

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

    assert _kinds("turn") == ["turn.upsert", "interaction.upsert"]


def test_block_adds_steps_and_frames_but_not_deltas() -> None:
    assert _kinds("block") == [
        "turn.upsert",
        "step.upsert",
        "frame.upsert",
        "interaction.upsert",
    ]


def test_delta_is_the_identity() -> None:

    assert filter_ops_for_grade("delta", BATCH) == BATCH


@pytest.mark.parametrize("grade", ["off", "turn", "block"])
def test_only_delta_carries_appends(grade: TranscriptGrade) -> None:
    """仅 delta 包含按 offset 追加的操作；其他粒度保留的操作可重复应用。

    筛空批次后客户端水位不变，重连补发必须仍然安全。
    """

    assert "append" not in _kinds(grade)


def test_no_grade_means_off_not_everything() -> None:

    assert grade_for({}, "main") == "off"
    assert grade_for({"*": "turn"}, "main") == "turn"
    assert grade_for({"main": "delta", "*": "turn"}, "main") == "delta"


def test_reset_only_when_the_grade_goes_up() -> None:

    assert needs_reset_on_transition("turn", "delta")
    assert not needs_reset_on_transition("delta", "turn")
    assert not needs_reset_on_transition("delta", "delta")
