"""验证实时 transcript 的批次序号、UTF-16 偏移、补发窗口和交互清理。"""

from __future__ import annotations

import pytest

from iclip.harness.transcript.store import TranscriptStore
from iclip.platform.transcript.ops import (
    AppendOp,
    FrameTarget,
    FrameUpsertOp,
    Interaction,
    InteractionUpsertOp,
    ItemsRemoveOp,
    StepHeader,
    StepUpsertOp,
    TextContent,
    TextFrame,
    ToolFrame,
    TurnHeader,
    TurnOrigin,
    TurnUpsertOp,
    utf16_len,
)

CONVERSATION = "conv-1"
AGENT = "main"


def _open_turn(store: TranscriptStore, *, turn: str = "t1", step: str = "t1.1") -> None:

    store.append(
        CONVERSATION,
        AGENT,
        (
            TurnUpsertOp(
                turn=TurnHeader(
                    turn_id=turn,
                    ordinal=1,
                    state="running",
                    origin=TurnOrigin(kind="user"),
                    content=(TextContent(text="走"),),
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
    """emoji 占两个 UTF-16 单位，Python len 不能直接作为客户端追加偏移。"""

    store = TranscriptStore()
    _open_turn(store)
    _append(store, 0, "好的👍")

    assert utf16_len("好的👍") == 4
    assert len("好的👍") == 3
    # UTF-16 偏移为 4；Python 字符数 3 应被拒绝。
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

    store = TranscriptStore(resident=4)
    for _ in range(3):
        store.append(CONVERSATION, AGENT, ())
    agent = store.subscribe_view(CONVERSATION, AGENT)
    assert agent.watermark == 3

    # 直接移除最早两批，模拟补发日志窗口过期。
    journal = store._conversations[CONVERSATION].agents[AGENT].journal  # pyright: ignore[reportPrivateUsage]
    journal.popleft()
    journal.popleft()

    view = store.subscribe_view(CONVERSATION, AGENT, since=0)
    assert view.complete is False


def test_catch_up_from_a_position_beyond_the_watermark_is_incomplete() -> None:

    store = TranscriptStore()
    store.append(CONVERSATION, AGENT, ())

    view = store.subscribe_view(CONVERSATION, AGENT, since=57)
    assert view.batches == ()
    assert view.complete is False


def test_removing_a_turn_cancels_the_interactions_anchored_to_its_tools() -> None:
    """删除轮次需取消关联审批，避免留下无法响应的交互。"""

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
    """实时轮需保留至消息快照持久化完成，避免交接期间两侧均无数据。"""

    store = TranscriptStore()
    _open_turn(store)
    store.append(
        CONVERSATION,
        AGENT,
        (
            TurnUpsertOp(
                turn=TurnHeader(
                    turn_id="t1",
                    ordinal=1,
                    state="completed",
                    origin=TurnOrigin(kind="user"),
                    content=(TextContent(text="走"),),
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
    """运行中或被订阅的对话不可淘汰，否则批次序号重置会中断流。"""

    store = TranscriptStore(resident=2)
    store.pin(CONVERSATION)
    store.append(CONVERSATION, AGENT, ())
    for index in range(5):
        store.append(f"other-{index}", AGENT, ())

    assert store.subscribe_view(CONVERSATION, AGENT).watermark == 1


def test_unpinned_conversations_are_evicted() -> None:
    """淘汰后序号从 1 开始，订阅端必须发送 reset。"""

    store = TranscriptStore(resident=2)
    store.append(CONVERSATION, AGENT, ())
    for index in range(5):
        store.append(f"other-{index}", AGENT, ())

    assert store.subscribe_view(CONVERSATION, AGENT).watermark == 0


def test_catch_up_after_eviction_is_only_safe_behind_a_reset() -> None:
    """batches 必须接在按 watermark 发送的 reset 之后。

    complete 无法区分淘汰前后的批次代际，客户端需由 reset 覆盖旧水位。
    """

    store = TranscriptStore(resident=2)
    store.append(CONVERSATION, AGENT, ())
    for index in range(5):
        store.append(f"other-{index}", AGENT, ())
    for _ in range(5):
        store.append(CONVERSATION, AGENT, ())

    view = store.subscribe_view(CONVERSATION, AGENT, since=3)
    assert view.watermark == 5
    assert [batch.seq for batch in view.batches] == [4, 5]
    assert view.complete is True
