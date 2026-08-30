"""从消息历史推 transcript。

这里的消息形状不是编的，是照着库里 32 段真实运行核对过的：每次响应都带思考块、一次响应可
以调多件工具、工具校验失败时用 ``RetryPromptPart`` 顶替返回、用户输入是文字与图片混排的
一串、收尾的重试提示不带 ``run_id``。
"""

from __future__ import annotations

from datetime import UTC, datetime

from pydantic_ai.messages import (
    ImageUrl,
    ModelRequest,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ThinkingPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.usage import RequestUsage

from iclip.harness.transcript.from_messages import turns_from_messages
from iclip.harness.transcript.ops import TextFrame, ThinkingFrame, ToolFrame

RUN = "axRdrOK"


def _at(minute: int) -> datetime:
    return datetime(2026, 8, 27, 6, minute, tzinfo=UTC)


def _ask(content: object, *, run_id: str | None = RUN, minute: int = 0) -> ModelRequest:
    return ModelRequest(
        parts=[UserPromptPart(content=content)],  # pyright: ignore[reportArgumentType]
        run_id=run_id,
        timestamp=_at(minute),
    )


def _reply(*parts: object, run_id: str | None = RUN, minute: int = 1) -> ModelResponse:
    return ModelResponse(
        parts=list(parts),  # pyright: ignore[reportArgumentType]
        run_id=run_id,
        timestamp=_at(minute),
        usage=RequestUsage(
            input_tokens=1000, cache_read_tokens=600, cache_write_tokens=100, output_tokens=50
        ),
        finish_reason="stop",
    )


def _returns(*parts: object, run_id: str | None = RUN, minute: int = 2) -> ModelRequest:
    return ModelRequest(
        parts=list(parts),  # pyright: ignore[reportArgumentType]
        run_id=run_id,
        timestamp=_at(minute),
    )


def test_one_run_becomes_one_turn_with_steps_per_response() -> None:
    """一次 run 就是一轮；每次模型响应是一步。"""

    turns = turns_from_messages(
        [
            _ask("帮我把 README 翻译成英文"),
            _reply(
                ThinkingPart(content="先读一下"),
                ToolCallPart(tool_name="Read", args={}, tool_call_id="c1"),
            ),
            _returns(ToolReturnPart(tool_name="Read", content="# iclip", tool_call_id="c1")),
            _reply(ThinkingPart(content="翻"), TextPart(content="# iclip"), minute=3),
        ]
    )

    assert len(turns) == 1
    turn = turns[0]
    assert turn.turn_id == "t1"
    assert turn.ordinal == 1
    assert turn.prompt == "帮我把 README 翻译成英文"
    assert turn.state == "completed"
    assert [step.step_id for step in turn.steps] == ["t1.1", "t1.2"]


def test_frame_ids_number_text_and_thinking_only() -> None:
    """正文块与思考块共用一个从 1 起的号；工具块用 toolCallId，不占这个号。"""

    turns = turns_from_messages(
        [
            _ask("走"),
            _reply(
                ThinkingPart(content="想"),
                TextPart(content="说"),
                ToolCallPart(tool_name="Read", args={}, tool_call_id="c1"),
                ToolCallPart(tool_name="Bash", args={}, tool_call_id="c2"),
            ),
        ]
    )

    assert [frame.frame_id for frame in turns[0].steps[0].frames] == [
        "t1.1.f1",
        "t1.1.f2",
        "t1.1.c1",
        "t1.1.c2",
    ]


def test_frame_numbering_restarts_each_step() -> None:
    turns = turns_from_messages(
        [
            _ask("走"),
            _reply(
                ThinkingPart(content="一"),
                ToolCallPart(tool_name="Read", args={}, tool_call_id="c1"),
            ),
            _returns(ToolReturnPart(tool_name="Read", content="x", tool_call_id="c1")),
            _reply(ThinkingPart(content="二"), TextPart(content="好"), minute=3),
        ]
    )

    assert [frame.frame_id for frame in turns[0].steps[1].frames] == ["t1.2.f1", "t1.2.f2"]


def test_tool_return_settles_the_card() -> None:
    turns = turns_from_messages(
        [
            _ask("走"),
            _reply(ToolCallPart(tool_name="Read", args={"path": "/a"}, tool_call_id="c1")),
            _returns(ToolReturnPart(tool_name="Read", content="内容", tool_call_id="c1")),
            _reply(TextPart(content="好"), minute=3),
        ]
    )

    card = turns[0].steps[0].frames[0]
    assert isinstance(card, ToolFrame)
    assert card.state == "done"
    assert card.output == "内容"
    assert card.error is None


def test_retry_prompt_marks_the_card_as_failed() -> None:
    """工具参数没过校验时没有返回，只有一条重试提示。漏了它界面上会留一张永远转圈的卡。"""

    turns = turns_from_messages(
        [
            _ask("走"),
            _reply(ToolCallPart(tool_name="generate_shot_frames", args={}, tool_call_id="c1")),
            _returns(
                RetryPromptPart(
                    tool_name="generate_shot_frames",
                    tool_call_id="c1",
                    content="帧号 S4-1 不在取帧账本中",
                )
            ),
            _reply(TextPart(content="换一个"), minute=3),
        ]
    )

    card = turns[0].steps[0].frames[0]
    assert isinstance(card, ToolFrame)
    assert card.state == "error"
    assert card.error is not None
    assert "S4-1" in card.error


def test_denied_and_interrupted_tools_are_errors() -> None:
    """协议只有三态。审批被拒、运行被停，都不是成功。"""

    turns = turns_from_messages(
        [
            _ask("走"),
            _reply(
                ToolCallPart(tool_name="Write", args={}, tool_call_id="c1"),
                ToolCallPart(tool_name="Bash", args={}, tool_call_id="c2"),
            ),
            _returns(
                ToolReturnPart(
                    tool_name="Write", content="用户拒绝", tool_call_id="c1", outcome="denied"
                ),
                ToolReturnPart(
                    tool_name="Bash", content="被打断", tool_call_id="c2", outcome="interrupted"
                ),
            ),
            _reply(TextPart(content="停了"), minute=3),
        ]
    )

    states = [frame.state for frame in turns[0].steps[0].frames if isinstance(frame, ToolFrame)]
    assert states == ["error", "error"]


def test_multimodal_prompt_keeps_the_text() -> None:
    """用户输入是文字与图片地址混排的一串，只取文字；图片归媒体那一层。"""

    turns = turns_from_messages(
        [
            _ask(["参考这两张图：", ImageUrl(url="https://example.invalid/a.png"), "做个 30 秒的"]),
            _reply(TextPart(content="好")),
        ]
    )

    assert turns[0].prompt == "参考这两张图：\n做个 30 秒的"


def test_trailing_message_without_a_run_id_stays_in_the_same_turn() -> None:
    """收尾的重试提示不带 run_id。单独成组会多出一个空轮子，还会因为时刻为空排到最前面。"""

    turns = turns_from_messages(
        [
            _ask("走"),
            _reply(ToolCallPart(tool_name="Read", args={}, tool_call_id="c1")),
            _returns(
                RetryPromptPart(tool_name="Read", tool_call_id="c1", content="不行"),
                run_id=None,
                minute=5,
            ),
        ]
    )

    assert len(turns) == 1
    card = turns[0].steps[0].frames[0]
    assert card.frame_id == "t1.1.c1"
    assert isinstance(card, ToolFrame)
    assert card.state == "error"


def test_two_runs_become_two_turns_in_time_order() -> None:
    turns = turns_from_messages(
        [
            _ask("第二次", run_id="run-b", minute=30),
            _reply(TextPart(content="B"), run_id="run-b", minute=31),
            _ask("第一次", run_id="run-a", minute=10),
            _reply(TextPart(content="A"), run_id="run-a", minute=11),
        ]
    )

    assert [(turn.turn_id, turn.prompt) for turn in turns] == [
        ("t1", "第一次"),
        ("t2", "第二次"),
    ]


def test_step_usage_splits_cache_out_of_the_input_total() -> None:
    """``input_tokens`` 是总数、缓存读写都算在里面，所以「其余」要把两块都减掉。"""

    turns = turns_from_messages([_ask("走"), _reply(TextPart(content="好"))])

    usage = turns[0].steps[0].usage
    assert usage is not None
    assert usage.input_other == 300
    assert usage.input_cache_read == 600
    assert usage.input_cache_creation == 100
    assert usage.output == 50


def test_turn_usage_sums_the_steps() -> None:
    """一轮的用量口径照协议：写缓存算进 input，读缓存单列。"""

    turns = turns_from_messages(
        [
            _ask("走"),
            _reply(ToolCallPart(tool_name="Read", args={}, tool_call_id="c1")),
            _returns(ToolReturnPart(tool_name="Read", content="x", tool_call_id="c1")),
            _reply(TextPart(content="好"), minute=3),
        ]
    )

    usage = turns[0].usage
    assert usage is not None
    assert usage.input_tokens == (300 + 100) * 2
    assert usage.cached_tokens == 600 * 2
    assert usage.output_tokens == 50 * 2


def test_a_run_that_never_answered_its_tools_is_not_completed() -> None:
    """停在一次工具调用上的 run 没跑完。分不清是被停掉还是报错——那要调用方查表覆盖。"""

    turns = turns_from_messages(
        [_ask("走"), _reply(ToolCallPart(tool_name="Read", args={}, tool_call_id="c1"))]
    )

    assert turns[0].state == "failed"
    assert (
        turns_from_messages(
            [_ask("走"), _reply(ToolCallPart(tool_name="Read", args={}, tool_call_id="c1"))],
            run_states={RUN: "cancelled"},
        )[0].state
        == "cancelled"
    )


def test_mid_run_user_message_becomes_a_user_frame_on_the_open_step() -> None:
    """插话：跑到一半进来的用户消息挂在当时开着的那一步末尾，与实时那条路一致。"""

    turns = turns_from_messages(
        [
            _ask("走"),
            _reply(TextPart(content="在做了")),
            _returns(UserPromptPart(content="等一下，改成英文"), minute=2),
            _reply(TextPart(content="好"), minute=3),
        ]
    )

    frames = turns[0].steps[0].frames
    assert [type(frame).__name__ for frame in frames] == ["TextFrame", "TextFrame"]
    steered = frames[1]
    assert isinstance(steered, TextFrame)
    assert steered.role == "user"
    assert steered.text == "等一下，改成英文"
    assert steered.frame_id == "t1.1.f2"


def test_thinking_frames_carry_their_text() -> None:
    turns = turns_from_messages(
        [_ask("走"), _reply(ThinkingPart(content="先想想"), TextPart(content="好"))]
    )

    thinking = turns[0].steps[0].frames[0]
    assert isinstance(thinking, ThinkingFrame)
    assert thinking.text == "先想想"
