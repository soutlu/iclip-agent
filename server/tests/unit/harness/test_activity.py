"""一段对话「在忙什么」的聚合，与它的去抖。

这几条错了都不响：侧栏角标永远转圈，或者等审批的那段对话看起来空闲。
"""

from __future__ import annotations

import pytest

from iclip.harness.transcript.activity import (
    IDLE,
    ActivityState,
    AgentWork,
    aggregate,
    merged_with_prompt,
)
from iclip.harness.transcript.store import TranscriptStore
from iclip.platform.transcript.ops import (
    Interaction,
    InteractionUpsertOp,
    TurnHeader,
    TurnOrigin,
    TurnUpsertOp,
)

pytestmark = pytest.mark.unit

MAIN = "main"
CONVERSATION = "c1"


def test_没人干活就是空闲() -> None:
    assert aggregate({}) == IDLE
    assert aggregate({MAIN: AgentWork(turn_active=False)}) == IDLE


def test_有轮子在跑就是忙() -> None:
    assert aggregate({MAIN: AgentWork(turn_active=True)}).busy is True


def test_任意一个agent在跑就算忙() -> None:
    work = {MAIN: AgentWork(turn_active=False), "sub": AgentWork(turn_active=True)}

    assert aggregate(work).busy is True


def test_等审批的时候照样是忙() -> None:
    """两个字段互不蕴含——合成一个枚举就分不清这两件事，kimi 为此废弃了它的单枚举。"""

    state = aggregate({MAIN: AgentWork(turn_active=True, pending_kinds=("approval",))})

    assert (state.busy, state.pending_interaction) == (True, "approval")


def test_审批比提问要紧() -> None:
    work = {MAIN: AgentWork(turn_active=True, pending_kinds=("question", "approval"))}

    assert aggregate(work).pending_interaction == "approval"


def test_库里那条占着的prompt也算忙() -> None:
    """实时状态是每 worker 一份的内存，重启后是空的。只看它的话侧栏会把还在忙的对话报成空闲。"""

    assert merged_with_prompt(IDLE, "running") == ActivityState(busy=True)
    assert merged_with_prompt(IDLE, "awaiting") == ActivityState(
        busy=True, pending_interaction="approval"
    )
    assert merged_with_prompt(IDLE, None) == IDLE


def test_合并取更忙的那一份() -> None:
    """实时那侧知道的更细（提问也算待人处理），合并不能把它盖掉。"""

    asking = ActivityState(busy=True, pending_interaction="question")

    assert merged_with_prompt(asking, "running") == asking
    assert merged_with_prompt(asking, "awaiting").pending_interaction == "approval"
    assert merged_with_prompt(ActivityState(busy=True), None) == ActivityState(busy=True)


def _turn(turn_id: str, state: str) -> TurnUpsertOp:
    return TurnUpsertOp(
        turn=TurnHeader(
            turn_id=turn_id,
            ordinal=1,
            state=state,  # pyright: ignore[reportArgumentType]
            origin=TurnOrigin(kind="user"),
        )
    )


def _interaction(interaction_id: str, kind: str, state: str) -> InteractionUpsertOp:
    return InteractionUpsertOp(
        interaction=Interaction(
            interaction_id=interaction_id,
            interaction_kind=kind,  # pyright: ignore[reportArgumentType]
            state=state,  # pyright: ignore[reportArgumentType]
        )
    )


def test_store_只在变了的时候说一声() -> None:
    """去抖：每来一批操作都惊动侧栏的话，一轮对话要发几十帧。"""

    seen: list[ActivityState] = []
    store = TranscriptStore(on_activity=lambda _conversation, state: seen.append(state))

    store.append(CONVERSATION, MAIN, (_turn("t1", "running"),))
    # 同一轮再来一批（比如逐字），活儿没变
    store.append(CONVERSATION, MAIN, (_turn("t1", "running"),))
    store.append(CONVERSATION, MAIN, (_turn("t1", "completed"),))

    assert seen == [ActivityState(busy=True), IDLE]


def test_store_把审批也报上去() -> None:
    seen: list[ActivityState] = []
    store = TranscriptStore(on_activity=lambda _conversation, state: seen.append(state))

    store.append(CONVERSATION, MAIN, (_turn("t1", "running"),))
    store.append(CONVERSATION, MAIN, (_interaction("i1", "approval", "pending"),))
    store.append(CONVERSATION, MAIN, (_interaction("i1", "approval", "approved"),))

    assert [state.pending_interaction for state in seen] == ["none", "approval", "none"]
    # 三次都在跑：点头这件事不影响那一轮还没结束
    assert all(state.busy for state in seen)


def test_读得到当下的活儿() -> None:
    store = TranscriptStore()

    assert store.activity(CONVERSATION) == IDLE
    store.append(CONVERSATION, MAIN, (_turn("t1", "running"),))
    assert store.activity(CONVERSATION) == ActivityState(busy=True)
