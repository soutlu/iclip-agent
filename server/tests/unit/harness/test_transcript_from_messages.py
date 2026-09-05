"""验证思考、多工具调用、重试、图文混排和无 run_id 收尾消息的历史 transcript 投影。"""

from __future__ import annotations

from datetime import UTC, datetime

from pydantic_ai.messages import (
    INTERRUPTED_TOOL_RETURN_CONTENT,
    CompactionPart,
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

from iclip.harness.media import media_tag_close, media_tag_open
from iclip.harness.transcript.from_messages import (
    ORPHAN_TOOL_ERROR,
    TurnState,
    approvals_from_messages,
    drop_last_turn,
    run_ids_from_messages,
    run_state_from_events,
    turn_run_ids,
    turn_usage,
    turns_from_messages,
)
from iclip.harness.transcript.prompt_media import model_prompt
from iclip.platform.transcript.display import (
    FileIoDisplay,
    GenericDisplay,
    ToolDisplayEntry,
    ToolDisplayRegistry,
)
from iclip.platform.transcript.ops import (
    COMPACTION_NOTICE,
    AttachmentSource,
    ImageContent,
    NoticeFrame,
    StepUsage,
    TextContent,
    TextFrame,
    ThinkingFrame,
    ToolFrame,
    TranscriptTurn,
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
    assert turn.content == (TextContent(text="帮我把 README 翻译成英文"),)
    assert [step.step_id for step in turn.steps] == ["t1.1", "t1.2"]


def test_frame_ids_number_text_and_thinking_only() -> None:

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
    """参数校验失败以 RetryPromptPart 代替工具返回，工具卡必须据此结束。"""

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
    assert card.metadata is None


def test_denied_and_interrupted_tools_are_errors() -> None:

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


def test_multimodal_prompt_keeps_the_part_order() -> None:
    """用户 parts 顺序决定图文相对位置，历史投影需保持原序。"""

    url = "https://example.invalid/a.png"
    turns = turns_from_messages(
        [
            _ask(
                [
                    "参考这张图：",
                    media_tag_open("image", url),
                    ImageUrl(url=f"{url}?x-oss-process=image/resize,l_1024"),
                    media_tag_close("image"),
                    "做个 30 秒的",
                ]
            ),
            _reply(TextPart(content="好")),
        ]
    )

    assert turns[0].content == (
        TextContent(text="参考这张图："),
        ImageContent(source=AttachmentSource(kind="url", url=url)),
        TextContent(text="做个 30 秒的"),
    )


def test_trailing_message_without_a_run_id_stays_in_the_same_turn() -> None:
    """无 run_id 的收尾重试消息应归属前一运行，避免生成时间戳为空的额外轮。"""

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

    assert [(turn.turn_id, turn.content) for turn in turns] == [
        ("t1", (TextContent(text="第一次"),)),
        ("t2", (TextContent(text="第二次"),)),
    ]


def _resumed() -> list[ModelRequest | ModelResponse]:
    """模拟同一 prompt 的中断与续跑；续跑首条请求包含工具补偿返回和追加用户消息。"""

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

    turns = turns_from_messages(
        _resumed(),
        turn_states={"r1": "failed", "r2": "completed"},
        prompt_of_run=_OF_ONE_PROMPT,
    )

    assert len(turns) == 1
    turn = turns[0]
    assert (turn.turn_id, turn.ordinal) == ("t1", 1)
    assert turn.content == (TextContent(text="出三张图"),)
    assert [step.step_id for step in turn.steps] == ["t1.1", "t1.2"]
    assert turn.started_at == _at(0).isoformat()
    assert turn.ended_at == _at(3).isoformat()


def test_the_turn_state_comes_from_the_last_run() -> None:
    """轮状态取最后一次运行；早期中断不应覆盖续跑成功的终态。"""

    turns = turns_from_messages(
        _resumed(),
        turn_states={"r1": "failed", "r2": "completed"},
        turn_errors={"r1": "RuntimeError('炸了')", "r2": None},
        prompt_of_run=_OF_ONE_PROMPT,
    )

    assert turns[0].state == "completed"
    assert turns[0].error is None
    assert [step.state for step in turns[0].steps] == ["interrupted", "completed"]

    broken_off: tuple[dict[str, TurnState], ...] = (
        {"r1": "cancelled", "r2": "completed"},
        {"r2": "completed"},
    )
    for states in broken_off:
        broken = turns_from_messages(_resumed(), turn_states=states, prompt_of_run=_OF_ONE_PROMPT)
        assert [step.state for step in broken[0].steps] == ["interrupted", "completed"]


def test_an_earlier_run_that_finished_keeps_its_last_step_completed() -> None:

    turns = turns_from_messages(
        _resumed(),
        turn_states={"r1": "completed", "r2": "completed"},
        prompt_of_run=_OF_ONE_PROMPT,
    )

    assert [step.state for step in turns[0].steps] == ["completed", "completed"]


def test_a_tool_call_is_settled_by_the_return_in_the_next_run() -> None:
    """工具调用可由下一运行的返回结束，卡片位置保留在原步骤。"""

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


def test_a_mid_turn_user_message_lands_on_the_previous_step() -> None:

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


def _awaiting() -> list[ModelRequest | ModelResponse]:
    """模拟待审批运行：以 run_completed 结束，但保留未返回调用；区别于运行中断。"""

    return [
        _ask("把这个文件改掉", run_id="r1", minute=0),
        _reply(
            TextPart(content="要动文件了"),
            ToolCallPart(tool_name="write_file", args={}, tool_call_id="c1"),
            run_id="r1",
            minute=1,
        ),
    ]


def _decided(outcome: str) -> list[ModelRequest | ModelResponse]:
    """审批续跑消息，首条请求包含待审批工具的返回。"""

    return [
        *_awaiting(),
        _returns(
            ToolReturnPart(
                tool_name="write_file",
                content="写好了" if outcome == "success" else "用户拒绝",
                tool_call_id="c1",
                outcome=outcome,  # pyright: ignore[reportArgumentType]
            ),
            run_id="r2",
            minute=2,
        ),
        _reply(TextPart(content="好了"), run_id="r2", minute=3),
    ]


_BOTH_COMPLETED: dict[str, TurnState] = {"r1": "completed", "r2": "completed"}
_SETTLED = {"r1": "completed", "r2": "completed"}


def _card(turn: TranscriptTurn) -> ToolFrame:
    card = turn.steps[0].frames[1]
    assert isinstance(card, ToolFrame)
    return card


def test_a_frontier_approval_waits_with_its_card_still_running() -> None:
    """待审批运行虽已完成，轮和工具卡仍为 running，步骤为 completed。"""

    messages = _awaiting()
    states: dict[str, TurnState] = {"r1": "completed"}
    turns = turns_from_messages(
        messages,
        turn_states=states,
        prompt_of_run={"r1": "p1"},
        prompt_status_of_run={"r1": "awaiting"},
    )

    assert turns[0].state == "running"
    assert [step.state for step in turns[0].steps] == ["completed"]
    assert (_card(turns[0]).state, _card(turns[0]).approval_id) == ("running", "apr_c1")
    assert [
        (item.interaction_id, item.tool_call_id, item.state)
        for item in approvals_from_messages(
            messages,
            turn_states=states,
            prompt_of_run={"r1": "p1"},
            prompt_status_of_run={"r1": "awaiting"},
        )
    ] == [("apr_c1", "c1", "pending")]


def test_a_frontier_approval_is_settled_by_the_prompt_that_stopped_waiting() -> None:

    messages = _awaiting()
    states: dict[str, TurnState] = {"r1": "completed"}
    for status, turn_state in (("aborted", "cancelled"), ("failed", "failed")):
        turns = turns_from_messages(
            messages,
            turn_states=states,
            prompt_of_run={"r1": "p1"},
            prompt_status_of_run={"r1": status},
        )
        assert turns[0].state == turn_state
        assert (_card(turns[0]).state, _card(turns[0]).error) == ("error", ORPHAN_TOOL_ERROR)
        assert [
            item.state
            for item in approvals_from_messages(
                messages,
                turn_states=states,
                prompt_of_run={"r1": "p1"},
                prompt_status_of_run={"r1": status},
            )
        ] == ["cancelled"]


def test_a_decision_is_read_off_the_return_in_the_next_run() -> None:

    for outcome, card_state, decision in (
        ("success", "done", "approved"),
        ("denied", "error", "rejected"),
    ):
        messages = _decided(outcome)
        turns = turns_from_messages(
            messages,
            turn_states=_BOTH_COMPLETED,
            prompt_of_run=_OF_ONE_PROMPT,
            prompt_status_of_run=_SETTLED,
        )

        assert turns[0].state == "completed"
        assert (_card(turns[0]).state, _card(turns[0]).approval_id) == (card_state, "apr_c1")
        assert [
            item.state
            for item in approvals_from_messages(
                messages,
                turn_states=_BOTH_COMPLETED,
                prompt_of_run=_OF_ONE_PROMPT,
                prompt_status_of_run=_SETTLED,
            )
        ] == [decision]


def test_a_close_out_return_is_not_a_decision() -> None:
    """悬空调用的补偿返回不代表用户批准；中断运行也不应产生审批交互。"""

    closed_out = [
        *_awaiting(),
        _returns(
            ToolReturnPart(
                tool_name="write_file", content="运行中断", tool_call_id="c1", outcome="failed"
            ),
            run_id="r2",
            minute=2,
        ),
        _reply(TextPart(content="换个做法"), run_id="r2", minute=3),
    ]
    turns = turns_from_messages(
        closed_out,
        turn_states=_BOTH_COMPLETED,
        prompt_of_run=_OF_ONE_PROMPT,
        prompt_status_of_run=_SETTLED,
    )
    assert (_card(turns[0]).state, _card(turns[0]).approval_id) == ("error", None)
    assert (
        approvals_from_messages(
            closed_out,
            turn_states=_BOTH_COMPLETED,
            prompt_of_run=_OF_ONE_PROMPT,
            prompt_status_of_run=_SETTLED,
        )
        == ()
    )
    assert (
        approvals_from_messages(
            _resumed(),
            turn_states={"r1": "failed", "r2": "completed"},
            prompt_of_run=_OF_ONE_PROMPT,
            prompt_status_of_run=_SETTLED,
        )
        == ()
    )


def test_an_official_repair_return_is_not_a_decision() -> None:
    """中断修复返回与审批返回形状相似，需结合运行是否正常结束判断。"""

    repaired = [
        *_awaiting(),
        _returns(
            ToolReturnPart(
                tool_name="write_file",
                content=INTERRUPTED_TOOL_RETURN_CONTENT,
                tool_call_id="c1",
                outcome="interrupted",
            ),
            run_id="r2",
            minute=2,
        ),
        _reply(TextPart(content="那我重新写一遍"), run_id="r2", minute=3),
    ]
    crashed: dict[str, TurnState] = {"r1": "failed", "r2": "completed"}
    turns = turns_from_messages(
        repaired, turn_states=crashed, prompt_of_run=_OF_ONE_PROMPT, prompt_status_of_run=_SETTLED
    )

    card = _card(turns[0])
    assert (card.state, card.error, card.approval_id) == (
        "error",
        INTERRUPTED_TOOL_RETURN_CONTENT,
        None,
    )
    assert (
        approvals_from_messages(
            repaired,
            turn_states=crashed,
            prompt_of_run=_OF_ONE_PROMPT,
            prompt_status_of_run=_SETTLED,
        )
        == ()
    )


def test_two_runs_without_a_mapping_stay_two_turns() -> None:

    turns = turns_from_messages(_resumed(), turn_states={"r1": "failed", "r2": "completed"})

    assert [(turn.turn_id, turn.content) for turn in turns] == [
        ("t1", (TextContent(text="出三张图"),)),
        ("t2", (TextContent(text="接着做"),)),
    ]
    assert [turn.state for turn in turns] == ["failed", "completed"]


def test_step_usage_splits_cache_out_of_the_input_total() -> None:
    """input_tokens 包含缓存读写，普通输入量需减去二者。"""

    turns = turns_from_messages([_ask("走"), _reply(TextPart(content="好"))])

    usage = turns[0].steps[0].usage
    assert usage is not None
    assert usage.input_other == 300
    assert usage.input_cache_read == 600
    assert usage.input_cache_creation == 100
    assert usage.output == 50


def test_turn_usage_adds_up_the_step_readings() -> None:
    """实时与历史共用用量汇总口径：写缓存计入 input，读缓存单列；全部缺失则省略。"""

    assert turn_usage([]) is None

    summed = turn_usage(
        [
            StepUsage(input_other=300, output=50, input_cache_read=600, input_cache_creation=100),
            StepUsage(input_other=200, output=20, input_cache_read=10, input_cache_creation=5),
        ]
    )
    assert summed is not None
    assert summed.input_tokens == 300 + 100 + 200 + 5
    assert summed.cached_tokens == 600 + 10
    assert summed.output_tokens == 50 + 20


def test_turn_usage_sums_the_steps() -> None:

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
    """最终响应形状无法区分完成与取消，必须使用调用方提供的终态；缺失时按 failed 处理。"""

    messages = [_ask("走"), _reply(TextPart(content="好"))]

    assert turns_from_messages(messages)[0].state == "failed"
    assert turns_from_messages(messages, turn_states={RUN: "completed"})[0].state == "completed"
    assert turns_from_messages(messages, turn_states={RUN: "cancelled"})[0].state == "cancelled"


def test_run_state_is_read_off_the_official_run_end_event() -> None:
    """取消与异常均记录为 run_failed，使用 error 异常名区分。"""

    def event(kind: str, error: str | None = None) -> StepEvent:
        return StepEvent(run_id="r1", kind=kind, step_index=0, error=error)  # pyright: ignore[reportArgumentType]

    assert run_state_from_events([event("run_started"), event("run_completed")]) == "completed"
    assert run_state_from_events([event("run_failed", "CancelledError()")]) == "cancelled"
    assert run_state_from_events([event("run_failed", "RunCancelled('用户停止')")]) == "cancelled"
    assert run_state_from_events([event("run_failed", "RemoteProtocolError('...')")]) == "failed"
    assert run_state_from_events([event("run_started")]) == "failed"


def test_mid_run_user_message_becomes_a_user_frame_on_the_open_step() -> None:
    """追加用户消息接在当前步骤末尾；工具块不占 f 序号。"""

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
    """首个模型响应前的追加消息暂存至第一步，避免无步骤时丢弃。"""

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
    """用户图片经过消息持久化后，须从 tag 恢复为原图 part。"""

    # 使用可缩放地址以生成完整的开标签、图片和闭标签三项，覆盖独立闭标签的解析。
    url = "https://bkt.oss-cn-hangzhou.aliyuncs.com/u/shot.png"
    items = model_prompt(
        (ImageContent(source=AttachmentSource(kind="url", url=url)), TextContent(text="照这张做"))
    )
    turns = turns_from_messages([_ask(items), _reply(TextPart(content="好"))])

    # 恢复 tag 中的原图地址，不能使用模型收到的缩略图地址。
    assert turns[0].content == (
        ImageContent(source=AttachmentSource(kind="url", url=url)),
        TextContent(text="照这张做"),
    )


def test_tool_card_carries_how_to_draw_it() -> None:

    displays = ToolDisplayRegistry.merged(
        {"read_file": lambda args: FileIoDisplay(operation="read", path=args["path"])}
    )
    turns = turns_from_messages(
        [
            _ask("看看"),
            _reply(
                ToolCallPart(tool_name="read_file", args={"path": "shots.md"}, tool_call_id="c1"),
                ToolCallPart(tool_name="generate_shot_frames", args={}, tool_call_id="c2"),
            ),
        ],
        display=displays,
    )

    cards = [f for f in turns[0].steps[0].frames if isinstance(f, ToolFrame)]
    assert cards[0].display == FileIoDisplay(operation="read", path="shots.md")
    assert cards[1].display == GenericDisplay(summary="generate_shot_frames")


def test_tool_card_carries_the_renderer_and_the_result_for_people() -> None:

    displays = ToolDisplayRegistry.merged(
        {
            "generate_shot_frames": ToolDisplayEntry(
                draw=lambda _args: GenericDisplay(summary="出图"), view="media_grid"
            )
        }
    )
    grid = {"items": [{"url": "https://cdn.test/s1-1.jpg", "caption": "S1-1"}]}
    turns = turns_from_messages(
        [
            _ask("出图"),
            _reply(ToolCallPart(tool_name="generate_shot_frames", args={}, tool_call_id="c1")),
            _returns(
                ToolReturnPart(
                    tool_name="generate_shot_frames",
                    content={"message": "生成完成 1 帧"},
                    tool_call_id="c1",
                    metadata=grid,
                )
            ),
            _reply(TextPart(content="好了"), minute=3),
        ],
        display=displays,
    )

    card = turns[0].steps[0].frames[0]
    assert isinstance(card, ToolFrame)
    assert card.view == "media_grid"
    assert card.metadata == grid
    assert card.output == {"message": "生成完成 1 帧"}


def test_drop_last_turn_on_empty_history_is_a_no_op() -> None:

    assert drop_last_turn([], {}) == ([], ())


def test_drop_last_turn_removes_exactly_the_last_group() -> None:

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

    messages = [
        _ask("第一问", run_id="r1", minute=0),
        _reply(TextPart(content="第一答"), run_id="r1", minute=1),
        _ask("第二问", run_id="r2", minute=2),
        _reply(TextPart(content="第二答"), run_id="r2", minute=3),
    ]
    dropped_ordinal = len(turn_run_ids(messages, {}))

    kept, _ = drop_last_turn(messages, {})

    assert len(turn_run_ids(kept, {})) + 1 == dropped_ordinal


def test_turn_run_ids_groups_the_runs_of_one_prompt() -> None:

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
    assert run_ids_from_messages(messages) == ("r1", "r2", "r3")


def _compaction(summary: str, *, run_id: str = RUN, minute: int) -> ModelResponse:
    """构造位于历史切点的压缩边界，其创建时间晚于列表中的相邻消息。"""

    return ModelResponse(
        parts=[CompactionPart(content=summary, provider_name="function")],
        run_id=run_id,
        timestamp=_at(minute),
    )


def test_a_compaction_boundary_is_not_a_step() -> None:
    """压缩边界不代表模型响应，不占步骤编号。"""

    turns = turns_from_messages(
        [
            _ask("走", minute=0),
            _compaction("旧账", minute=1),
            _reply(TextPart(content="好"), minute=2),
            _returns(minute=3),
            _reply(TextPart(content="完了"), minute=4),
        ]
    )

    assert [step.step_id for step in turns[0].steps] == ["t1.1", "t1.2"]


def test_the_compaction_notice_hangs_on_the_first_step_after_it() -> None:
    """压缩提示按边界时间关联后续步骤，不能按边界所在的历史列表位置关联。"""

    turns = turns_from_messages(
        [
            _ask("走", minute=0),
            _reply(TextPart(content="第一步"), minute=1),
            _returns(minute=2),
            _compaction("旧账", minute=3),
            _reply(TextPart(content="第二步"), minute=4),
        ]
    )

    first, second = turns[0].steps
    assert [frame.frame_id for frame in first.frames] == ["t1.1.f1"]
    notice = second.frames[0]
    assert isinstance(notice, NoticeFrame)
    assert [frame.frame_id for frame in second.frames] == ["t1.2.compaction", "t1.2.f1"]
    assert (notice.level, notice.message, notice.detail) == ("info", COMPACTION_NOTICE, "旧账")


def test_a_boundary_with_no_step_after_it_shows_nothing() -> None:
    """压缩后请求失败而未产生步骤时，不展示压缩提示。"""

    turns = turns_from_messages(
        [
            _ask("走", minute=0),
            _reply(TextPart(content="好"), minute=1),
            _compaction("旧账", minute=2),
        ]
    )

    assert [frame.frame_id for frame in turns[0].steps[0].frames] == ["t1.1.f1"]


def test_a_boundary_does_not_become_the_turns_start_time() -> None:
    """边界列表位置早于当前 run 消息，但创建时间较晚，不能作为轮开始时间。"""

    turns = turns_from_messages(
        [
            _ask("第一问", run_id="r1", minute=0),
            _reply(TextPart(content="第一答"), run_id="r1", minute=1),
            _compaction("旧账", run_id="r2", minute=8),
            _ask("第二问", run_id="r2", minute=2),
            _reply(TextPart(content="第二答"), run_id="r2", minute=3),
        ]
    )

    assert [turn.started_at for turn in turns] == [_at(0).isoformat(), _at(2).isoformat()]


def test_drop_last_turn_takes_the_boundary_of_that_run_with_it() -> None:

    messages = [
        _ask("第一问", run_id="r1", minute=0),
        _reply(TextPart(content="第一答"), run_id="r1", minute=1),
        _ask("第二问", run_id="r2", minute=2),
        _compaction("旧账", run_id="r2", minute=8),
        _reply(TextPart(content="第二答"), run_id="r2", minute=3),
    ]

    kept, dropped = drop_last_turn(messages, {})

    assert dropped == ("r2",)
    assert kept == messages[:2]


def test_a_boundary_merged_into_a_response_still_shows_its_notice() -> None:
    """边界合入响应后需按 part 识别；响应仍计为步骤，压缩提示保持可见。"""

    merged = ModelResponse(
        parts=[
            CompactionPart(content="旧账", provider_name="function"),
            TextPart(content="第一答"),
        ],
        run_id=RUN,
        # 框架合并时保留前一条消息的时间戳。
        timestamp=_at(8),
    )
    turns = turns_from_messages(
        [
            _ask("走", minute=0),
            merged,
            _returns(minute=9),
            _reply(TextPart(content="第二答"), minute=10),
        ]
    )

    assert [step.step_id for step in turns[0].steps] == ["t1.1", "t1.2"]
    assert [frame.frame_id for frame in turns[0].steps[0].frames] == ["t1.1.f1"]
    assert [frame.frame_id for frame in turns[0].steps[1].frames] == ["t1.2.compaction", "t1.2.f1"]
