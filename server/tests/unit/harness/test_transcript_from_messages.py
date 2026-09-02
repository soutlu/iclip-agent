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
from pydantic_ai_harness.step_persistence import StepEvent

from iclip.harness.transcript.from_messages import (
    TurnState,
    drop_last_turn,
    run_ids_from_messages,
    run_state_from_events,
    turn_run_ids,
    turns_from_messages,
)
from iclip.harness.transcript.prompt_media import attachment_id, model_prompt
from iclip.platform.transcript.display import FileIoDisplay, GenericDisplay
from iclip.platform.transcript.ops import (
    AttachmentSource,
    ImageContent,
    TextContent,
    TextFrame,
    ThinkingFrame,
    ToolFrame,
)

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


def _resumed() -> list[ModelRequest | ModelResponse]:
    """一条 prompt 跨两次 run 的消息：``r1`` 断在一次工具调用上，``r2`` 从那里续跑。

    续跑那次 run 的第一条请求里有两样东西：给悬空调用补的那份失败返回，和固定的续跑触发语。
    """

    return [
        _ask("出三张图", run_id="r1", minute=0),
        _reply(
            TextPart(content="在做了"),
            ToolCallPart(tool_name="Read", args={}, tool_call_id="c1"),
            run_id="r1",
            minute=1,
        ),
        _returns(
            ToolReturnPart(
                tool_name="Read", content="运行中断", tool_call_id="c1", outcome="interrupted"
            ),
            UserPromptPart(content="接着做"),
            run_id="r2",
            minute=2,
        ),
        _reply(TextPart(content="好了"), run_id="r2", minute=3),
    ]


_OF_ONE_PROMPT = {"r1": "p1", "r2": "p1"}


def test_two_runs_of_one_prompt_become_one_turn() -> None:
    """同一条 prompt 的两次 run 合成一轮：轮号 1，步号跨 run 接着数，时刻按整轮算。"""

    turns = turns_from_messages(
        _resumed(),
        turn_states={"r1": "failed", "r2": "completed"},
        prompt_of_run=_OF_ONE_PROMPT,
    )

    assert len(turns) == 1
    turn = turns[0]
    assert (turn.turn_id, turn.ordinal) == ("t1", 1)
    assert turn.prompt == "出三张图"  # 轮头部仍是整轮第一句用户输入
    assert [step.step_id for step in turn.steps] == ["t1.1", "t1.2"]
    assert turn.started_at == _at(0).isoformat()
    assert turn.ended_at == _at(3).isoformat()


def test_the_turn_state_comes_from_the_last_run() -> None:
    """轮的终态取最后一次 run 的；更早那次没跑完的，它最后一步是 ``interrupted``。

    按第一次 run 判的话，一条续跑成功的 prompt 在界面上会显示成失败。
    """

    turns = turns_from_messages(
        _resumed(),
        turn_states={"r1": "failed", "r2": "completed"},
        turn_errors={"r1": "RuntimeError('炸了')", "r2": None},
        prompt_of_run=_OF_ONE_PROMPT,
    )

    assert turns[0].state == "completed"
    assert turns[0].error is None
    assert [step.state for step in turns[0].steps] == ["interrupted", "completed"]

    # 「没跑完」的另外两种：被停的，和一条结束事件都没记下的。
    broken_off: tuple[dict[str, TurnState], ...] = (
        {"r1": "cancelled", "r2": "completed"},
        {"r2": "completed"},
    )
    for states in broken_off:
        broken = turns_from_messages(_resumed(), turn_states=states, prompt_of_run=_OF_ONE_PROMPT)
        assert [step.state for step in broken[0].steps] == ["interrupted", "completed"]


def test_an_earlier_run_that_finished_keeps_its_last_step_completed() -> None:
    """更早那次 run 是干净收尾的（审批结束的那种），它最后一步照旧是 ``completed``。"""

    turns = turns_from_messages(
        _resumed(),
        turn_states={"r1": "completed", "r2": "completed"},
        prompt_of_run=_OF_ONE_PROMPT,
    )

    assert [step.state for step in turns[0].steps] == ["completed", "completed"]


def test_a_tool_call_is_settled_by_the_return_in_the_next_run() -> None:
    """前一段发起的工具调用，由后一段第一条请求里那份收尾返回结掉，卡还留在前一段那一步。

    不跨段结的话那张卡会被当成没等到返回，写上「运行中断」那句兜底文字——而库里明明有它的结局。
    """

    turns = turns_from_messages(
        _resumed(),
        turn_states={"r1": "failed", "r2": "completed"},
        prompt_of_run=_OF_ONE_PROMPT,
    )

    card = turns[0].steps[0].frames[1]
    assert isinstance(card, ToolFrame)
    assert card.frame_id == "t1.1.c1"
    assert card.state == "error"
    assert card.error == "运行中断"


def test_the_resume_prompt_lands_on_the_previous_step() -> None:
    """续跑触发语按「轮中间的用户消息」处理：挂在前一段末步的末尾，与插话同形。"""

    turns = turns_from_messages(
        _resumed(),
        turn_states={"r1": "failed", "r2": "completed"},
        prompt_of_run=_OF_ONE_PROMPT,
    )

    frames = turns[0].steps[0].frames
    assert [frame.frame_id for frame in frames] == ["t1.1.f1", "t1.1.c1", "t1.1.f2"]
    resumed = frames[2]
    assert isinstance(resumed, TextFrame)
    assert resumed.role == "user"
    assert resumed.text == "接着做"


def test_two_runs_without_a_mapping_stay_two_turns() -> None:
    """没有映射就各自成轮：``prompt_runs`` 建表之前的旧数据照旧一次 run 一轮。"""

    turns = turns_from_messages(_resumed(), turn_states={"r1": "failed", "r2": "completed"})

    assert [(turn.turn_id, turn.prompt) for turn in turns] == [("t1", "出三张图"), ("t2", "接着做")]
    assert [turn.state for turn in turns] == ["failed", "completed"]


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


def test_terminal_state_comes_from_the_caller_not_from_the_message_shape() -> None:
    """终态不猜。

    库里有一段对话的消息停在一条没有工具调用的响应上、看着像正常收尾，官方记的却是被取消。
    按消息形状猜会把「被取消」说成「已完成」，方向正好反了。没给终态时给 ``failed``——那是
    「没记下一次干净的收尾」，不是默认跑完了。
    """

    messages = [_ask("走"), _reply(TextPart(content="好"))]

    assert turns_from_messages(messages)[0].state == "failed"
    assert turns_from_messages(messages, turn_states={RUN: "completed"})[0].state == "completed"
    assert turns_from_messages(messages, turn_states={RUN: "cancelled"})[0].state == "cancelled"


def test_run_state_is_read_off_the_official_run_end_event() -> None:
    """取消与报错都写成 ``run_failed``，区别在 ``error`` 那一列的异常名。"""

    def event(kind: str, error: str | None = None) -> StepEvent:
        return StepEvent(run_id="r1", kind=kind, step_index=0, error=error)  # pyright: ignore[reportArgumentType]

    assert run_state_from_events([event("run_started"), event("run_completed")]) == "completed"
    assert run_state_from_events([event("run_failed", "CancelledError()")]) == "cancelled"
    assert run_state_from_events([event("run_failed", "RunCancelled('用户停止')")]) == "cancelled"
    assert run_state_from_events([event("run_failed", "RemoteProtocolError('...')")]) == "failed"
    # 一条结束事件都没有：进程没活到写它。那也不是跑完了。
    assert run_state_from_events([event("run_started")]) == "failed"


def test_mid_run_user_message_becomes_a_user_frame_on_the_open_step() -> None:
    """插话：跑到一半进来的用户消息挂在当时开着的那一步末尾，与实时那条路一致。

    这一步里有工具块，而工具块不占 f 号——按块的个数编号会编成 f3，两条路就对不上了。
    """

    turns = turns_from_messages(
        [
            _ask("走"),
            _reply(
                TextPart(content="在做了"),
                ToolCallPart(tool_name="Read", args={}, tool_call_id="c1"),
            ),
            _returns(
                ToolReturnPart(tool_name="Read", content="x", tool_call_id="c1"),
                UserPromptPart(content="等一下，改成英文"),
                minute=2,
            ),
            _reply(TextPart(content="好"), minute=3),
        ]
    )

    frames = turns[0].steps[0].frames
    assert [frame.frame_id for frame in frames] == ["t1.1.f1", "t1.1.c1", "t1.1.f2"]
    steered = frames[2]
    assert isinstance(steered, TextFrame)
    assert steered.role == "user"
    assert steered.text == "等一下，改成英文"


def test_a_steer_arriving_before_any_step_leads_the_first_one() -> None:
    """插话赶在第一次模型响应之前进来时没有步可挂。丢掉的话它在界面上就凭空消失了。"""

    turns = turns_from_messages(
        [
            _ask("走"),
            _returns(UserPromptPart(content="补充一句"), minute=1),
            _reply(TextPart(content="好"), minute=2),
        ]
    )

    frames = turns[0].steps[0].frames
    assert [frame.frame_id for frame in frames] == ["t1.1.f1", "t1.1.f2"]
    leading = frames[0]
    assert isinstance(leading, TextFrame)
    assert leading.role == "user"
    assert leading.text == "补充一句"


def test_thinking_frames_carry_their_text() -> None:
    turns = turns_from_messages(
        [_ask("走"), _reply(ThinkingPart(content="先想想"), TextPart(content="好"))]
    )

    thinking = turns[0].steps[0].frames[0]
    assert isinstance(thinking, ThinkingFrame)
    assert thinking.text == "先想想"


def test_attached_image_survives_the_round_trip() -> None:
    """附件不能在路上丢：进模型那一串里带着 tag，从消息推回来时还原成协议的附件实体。

    漏了这条，用户附的图会被收下、落库、然后无声消失——tag 当成用户打的字显示出来，
    而界面上根本没有那张图。
    """

    # 地址得是缩得动的那种：缩不动的图只留一条空标签，而图片真实的形状是「开标签 + 像素 +
    # 闭标签」三项，闭标签落单——它正是最容易被漏掉的那一项。
    url = "https://bkt.oss-cn-hangzhou.aliyuncs.com/u/shot.png"
    items = model_prompt(
        (ImageContent(source=AttachmentSource(kind="url", url=url)), TextContent(text="照这张做"))
    )
    turns = turns_from_messages([_ask(items), _reply(TextPart(content="好"))])

    turn = turns[0]
    assert turn.prompt == "照这张做"  # tag 不算用户打的字
    assert turn.attachment_ids == (attachment_id(url),)


def test_tool_card_carries_how_to_draw_it() -> None:
    """客户端不认工具名，只认 display 里的 kind。认不出的工具退回 generic，不画错。"""

    turns = turns_from_messages(
        [
            _ask("看看"),
            _reply(
                ToolCallPart(tool_name="read_file", args={"path": "shots.md"}, tool_call_id="c1"),
                ToolCallPart(tool_name="generate_shot_frames", args={}, tool_call_id="c2"),
            ),
        ]
    )

    cards = [f for f in turns[0].steps[0].frames if isinstance(f, ToolFrame)]
    assert cards[0].display == FileIoDisplay(operation="read", path="shots.md")
    assert cards[1].display == GenericDisplay(summary="出镜头帧")


def test_drop_last_turn_on_empty_history_is_a_no_op() -> None:
    """一份消息都没有就没什么可截，调用方按「没有末轮」处理。"""

    assert drop_last_turn([], {}) == ([], ())


def test_drop_last_turn_removes_exactly_the_last_group() -> None:
    """截断只摘走最后一轮的那组，前面的消息一条不动。"""

    messages = [
        _ask("第一问", run_id="r1", minute=0),
        _reply(TextPart(content="第一答"), run_id="r1", minute=1),
        _ask("第二问", run_id="r2", minute=2),
        _reply(TextPart(content="第二答"), run_id="r2", minute=3),
    ]

    kept, dropped = drop_last_turn(messages, {})

    assert dropped == ("r2",)
    assert kept == messages[:2]


def test_drop_last_turn_takes_every_run_of_that_turn() -> None:
    """末轮跨了两次 run：一起摘走，留一段下来它会自成一轮。"""

    messages = [
        _ask("第一问", run_id="r1", minute=0),
        _reply(TextPart(content="第一答"), run_id="r1", minute=1),
        _ask("第二问", run_id="r2", minute=2),
        _reply(TextPart(content="写到一半"), run_id="r2", minute=3),
        _ask("接着做", run_id="r3", minute=4),
        _reply(TextPart(content="第二答"), run_id="r3", minute=5),
    ]

    kept, dropped = drop_last_turn(messages, {"r1": "p1", "r2": "p2", "r3": "p2"})

    assert dropped == ("r2", "r3")
    assert kept == messages[:2]


def test_drop_last_turn_takes_trailing_unstamped_messages_with_it() -> None:
    """末尾不带 run_id 的消息挂在前一次 run 上，截断时跟着那一轮一起走。"""

    messages = [
        _ask("第一问", run_id="r1", minute=0),
        _reply(TextPart(content="第一答"), run_id="r1", minute=1),
        _ask("第二问", run_id="r2", minute=2),
        _returns(RetryPromptPart(content="参数不对", tool_call_id="c1"), run_id=None, minute=3),
    ]

    kept, dropped = drop_last_turn(messages, {})

    assert dropped == ("r2",)
    assert kept == messages[:2]


def test_truncation_reuses_the_dropped_ordinal() -> None:
    """截掉末轮之后，下一轮的轮号（``len(turn_run_ids) + 1``）正好复用被摘掉那一轮的号。"""

    messages = [
        _ask("第一问", run_id="r1", minute=0),
        _reply(TextPart(content="第一答"), run_id="r1", minute=1),
        _ask("第二问", run_id="r2", minute=2),
        _reply(TextPart(content="第二答"), run_id="r2", minute=3),
    ]
    dropped_ordinal = len(turn_run_ids(messages, {}))  # 被摘掉那一轮的轮号

    kept, _ = drop_last_turn(messages, {})

    assert len(turn_run_ids(kept, {})) + 1 == dropped_ordinal


def test_turn_run_ids_groups_the_runs_of_one_prompt() -> None:
    """一条 prompt 的几次 run 归一轮；没有映射的各自成轮，两个「没有映射」不算同一条。"""

    messages = [
        _ask("第一问", run_id="r1", minute=0),
        _reply(TextPart(content="第一答"), run_id="r1", minute=1),
        _ask("第二问", run_id="r2", minute=2),
        _reply(TextPart(content="写到一半"), run_id="r2", minute=3),
        _ask("接着做", run_id="r3", minute=4),
        _reply(TextPart(content="第二答"), run_id="r3", minute=5),
    ]

    assert turn_run_ids(messages, {"r1": "p1", "r2": "p2", "r3": "p2"}) == (("r1",), ("r2", "r3"))
    assert turn_run_ids(messages, {}) == (("r1",), ("r2",), ("r3",))
    # run_id 仍按 run 逐个给：事件按 run 查，交接也按 run 核对。
    assert run_ids_from_messages(messages) == ("r1", "r2", "r3")
