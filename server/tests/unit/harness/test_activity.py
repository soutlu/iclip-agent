"""jobs 表里那一行状态 → 一段对话「在忙什么」。

这几条错了都不响：侧栏角标永远转圈，或者等审批的那段对话看起来空闲。
"""

from __future__ import annotations

import pytest

from iclip.harness.transcript.activity import IDLE, ActivityState, activity_of

pytestmark = pytest.mark.unit


def test_在跑就是忙() -> None:
    assert activity_of("running") == ActivityState(busy=True)


def test_递进这一轮的插话也算忙() -> None:
    """``steered`` 那条跟着它递进的那一轮走，那一轮还在跑。"""

    assert activity_of("steered") == ActivityState(busy=True)


def test_等审批的时候照样是忙() -> None:
    """两个字段互不蕴含——合成一个枚举就分不清这两件事，kimi 为此废弃了它的单枚举。"""

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
    # 排着的那条从来不是决定活儿的那一行
    assert activity_of("queued") == IDLE
    assert IDLE.last_turn_reason is None
