"""验证任务状态到会话活动状态的映射。"""

from __future__ import annotations

import pytest

from iclip.harness.transcript.activity import IDLE, ActivityState, activity_of

pytestmark = pytest.mark.unit


def test_在跑就是忙() -> None:
    assert activity_of("running") == ActivityState(busy=True)


def test_递进这一轮的插话也算忙() -> None:

    assert activity_of("steered") == ActivityState(busy=True)


def test_等审批的时候照样是忙() -> None:
    """运行中与待审批是独立状态，不能合并为互斥枚举。"""

    state = activity_of("awaiting")

    assert (state.busy, state.pending_interaction) == (True, "approval")
    assert state.last_turn_reason is None


def test_收场之后不忙但记着结局() -> None:
    for status in ("completed", "failed", "aborted"):
        state = activity_of(status)  # pyright: ignore[reportArgumentType]

        assert (state.busy, state.pending_interaction) == (False, "none")
        assert state.last_turn_reason == status


def test_没有决定活儿的那一行就是空闲() -> None:
    assert activity_of(None) == IDLE
    assert activity_of("queued") == IDLE
    assert IDLE.last_turn_reason is None
