"""实时 transcript 状态：批次号、追加位置、补批窗口、撤销连带。

这几条违反了都不会报错，只会让客户端反复整页重拉，所以逐条钉住。
"""

from __future__ import annotations

import pytest

from iclip.harness.transcript.ops import (
    AppendOp,
    FrameTarget,
    FrameUpsertOp,
    Interaction,
    InteractionUpsertOp,
    ItemsRemoveOp,
    StepHeader,
    StepUpsertOp,
    TextFrame,
    ToolFrame,
    TurnHeader,
    TurnOrigin,
    TurnUpsertOp,
    utf16_len,
)
from iclip.harness.transcript.store import TranscriptStore

CONVERSATION = "conv-1"
AGENT = "main"


def _open_turn(store: TranscriptStore, *, turn: str = "t1", step: str = "t1.1") -> None:
    """开一轮、开一步、建一个空的正文块——追加操作的最小前置。"""

    store.append(
        CONVERSATION,
        AGENT,
        (
            TurnUpsertOp(
                turn=TurnHeader(
                    turn_id=turn, ordinal=1, state="running", origin=TurnOrigin(kind="user")
                )
            ),
            StepUpsertOp(
                turn_id=turn,
                step=StepHeader(step_id=step, turn_id=turn, ordinal=1, state="running"),
            ),
            FrameUpsertOp(
                turn_id=turn,
                step_id=step,
                frame=TextFrame(frame_id=f"{step}.f1", role="assistant", text=""),
            ),
        ),
    )


def _first_text(store: TranscriptStore) -> str:
    """取第一轮第一步第一个块的正文。"""

    frame = store.subscribe_view(CONVERSATION, AGENT).live_turns[0].steps[0].frames[0]
    assert isinstance(frame, TextFrame)
    return frame.text


def _append(store: TranscriptStore, offset: int, text: str, *, frame: str = "t1.1.f1") -> None:
    store.append(
        CONVERSATION,
        AGENT,
        (
            AppendOp(
                target=FrameTarget(turn_id="t1", step_id="t1.1", frame_id=frame),
                offset=offset,
                text=text,
            ),
        ),
    )


def test_batch_numbers_are_contiguous_from_one() -> None:
    """协议要求每 agent 连续递增：客户端跳一个就判丢批。"""

    store = TranscriptStore()
    seqs = [store.append(CONVERSATION, AGENT, ()).seq for _ in range(5)]
    assert seqs == [1, 2, 3, 4, 5]


def test_watermark_follows_the_last_batch() -> None:
    store = TranscriptStore()
    _open_turn(store)
    assert store.subscribe_view(CONVERSATION, AGENT).watermark == 1


def test_append_accumulates_text_on_the_frame() -> None:
    store = TranscriptStore()
    _open_turn(store)
    _append(store, 0, "好的")
    _append(store, 2, "，我来看看")

    assert _first_text(store) == "好的，我来看看"


def test_append_offset_is_counted_in_utf16_units() -> None:
    """emoji 在 UTF-16 里算两个单位。按 Python 的 len() 发号，客户端会永远对不上。"""

    store = TranscriptStore()
    _open_turn(store)
    _append(store, 0, "好的👍")

    assert utf16_len("好的👍") == 4
    assert len("好的👍") == 3
    # 下一条要从 4 接。给 3（Python 的长度）必须被当场拒绝。
    with pytest.raises(ValueError, match="追加位置对不上"):
        _append(store, 3, "继续")
    _append(store, 4, "继续")
    assert _first_text(store) == "好的👍继续"


def test_catch_up_returns_the_batches_after_the_given_position() -> None:
    store = TranscriptStore()
    for _ in range(5):
        store.append(CONVERSATION, AGENT, ())

    view = store.subscribe_view(CONVERSATION, AGENT, since=2)
    assert [batch.seq for batch in view.batches] == [3, 4, 5]
    assert view.complete is True


def test_catch_up_reports_incomplete_when_the_window_has_moved_past() -> None:
    """要的批次已经出了日志窗口。答不全就得说，不能默默给一段。"""

    store = TranscriptStore(resident=4)
    for _ in range(3):
        store.append(CONVERSATION, AGENT, ())
    agent = store.subscribe_view(CONVERSATION, AGENT)
    assert agent.watermark == 3

    # 手工把窗口推过去：日志容量在实现里是 2000 批，这里直接丢掉最老的两批。
    journal = store._conversations[CONVERSATION].agents[AGENT].journal  # pyright: ignore[reportPrivateUsage]
    journal.popleft()
    journal.popleft()

    view = store.subscribe_view(CONVERSATION, AGENT, since=0)
    assert view.complete is False


def test_catch_up_from_a_position_beyond_the_watermark_is_incomplete() -> None:
    """进程重启后水位从 1 起。客户端手里那个大号来自上一代，必须让它整页重拉。"""

    store = TranscriptStore()
    store.append(CONVERSATION, AGENT, ())

    view = store.subscribe_view(CONVERSATION, AGENT, since=57)
    assert view.batches == ()
    assert view.complete is False


def test_removing_a_turn_cancels_the_interactions_anchored_to_its_tools() -> None:
    """少这一步，撤销之后界面上会留下永远等不到回应的审批卡。"""

    store = TranscriptStore()
    _open_turn(store)
    store.append(
        CONVERSATION,
        AGENT,
        (
            FrameUpsertOp(
                turn_id="t1",
                step_id="t1.1",
                frame=ToolFrame(
                    frame_id="t1.1.call_9f2a",
                    tool_call_id="call_9f2a",
                    name="Read",
                    state="running",
                ),
            ),
            InteractionUpsertOp(
                interaction=Interaction(
                    interaction_id="apr_1",
                    interaction_kind="approval",
                    tool_call_id="call_9f2a",
                    state="pending",
                )
            ),
        ),
    )
    assert len(store.pending_interactions(CONVERSATION, AGENT)) == 1

    store.append(CONVERSATION, AGENT, (ItemsRemoveOp(ids=("t1",)),))
    assert store.pending_interactions(CONVERSATION, AGENT) == ()


def test_a_turn_is_held_until_the_message_history_has_it() -> None:
    """交接点是「快照落库了」，不是「轮子进了终态」——中间丢掉两边都拿不出它。"""

    store = TranscriptStore()
    _open_turn(store)
    store.append(
        CONVERSATION,
        AGENT,
        (
            TurnUpsertOp(
                turn=TurnHeader(
                    turn_id="t1", ordinal=1, state="completed", origin=TurnOrigin(kind="user")
                )
            ),
        ),
    )

    store.drop_persisted_turns(CONVERSATION, AGENT)
    assert len(store.subscribe_view(CONVERSATION, AGENT).live_turns) == 1

    store.mark_snapshot_persisted(CONVERSATION, AGENT, "t1")
    store.drop_persisted_turns(CONVERSATION, AGENT)
    assert store.subscribe_view(CONVERSATION, AGENT).live_turns == ()


def test_pinned_conversations_survive_eviction() -> None:
    """有运行在跑或有连接订阅着的对话被淘汰，会让批次号从头开始，流到一半分叉。"""

    store = TranscriptStore(resident=2)
    store.pin(CONVERSATION)
    store.append(CONVERSATION, AGENT, ())
    for index in range(5):
        store.append(f"other-{index}", AGENT, ())

    assert store.subscribe_view(CONVERSATION, AGENT).watermark == 1


def test_unpinned_conversations_are_evicted() -> None:
    """淘汰之后重新装上，批次号从 1 重来——所以订阅路径上那帧 reset 是必需的，见下一条。"""

    store = TranscriptStore(resident=2)
    store.append(CONVERSATION, AGENT, ())
    for index in range(5):
        store.append(f"other-{index}", AGENT, ())

    assert store.subscribe_view(CONVERSATION, AGENT).watermark == 0


def test_catch_up_after_eviction_is_only_safe_behind_a_reset() -> None:
    """钉住调用方契约：``batches`` 要接在按 ``watermark`` 发的那帧 reset 后面。

    这段对话被淘汰过，号重新从 1 起。客户端手里还揣着上一代的 3。这里照样会给出新一代的
    批次，而且 ``complete`` 是真——单看这个返回值分不出代际。让它落在对位置上的是那帧
    reset：客户端收到就把本地水位无条件覆写成 ``watermark``。少发那一帧，客户端会拿新一代
    的 4、5 去接上一代的第 3 批。
    """

    store = TranscriptStore(resident=2)
    store.append(CONVERSATION, AGENT, ())  # 上一代
    for index in range(5):
        store.append(f"other-{index}", AGENT, ())  # 挤掉它
    for _ in range(5):
        store.append(CONVERSATION, AGENT, ())  # 新一代，号从 1 起

    view = store.subscribe_view(CONVERSATION, AGENT, since=3)
    assert view.watermark == 5
    assert [batch.seq for batch in view.batches] == [4, 5]
    assert view.complete is True
