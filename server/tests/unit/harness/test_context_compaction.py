"""上下文压缩：边界留在历史里，窗口在发送时现算。

这几条错了都不响：模型悄悄收到整份历史（压了等于没压），或者快照里只剩窗口那几条——
被摘掉的轮子从此在界面上消失，而且没有任何报错。
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pydantic_ai import Agent
from pydantic_ai.messages import (
    CompactionPart,
    ModelMessage,
    ModelRequest,
    ModelResponse,
    SystemPromptPart,
    TextPart,
    UserPromptPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai_harness.compaction import SummarizingCompaction
from pydantic_ai_harness.step_persistence import InMemoryStepStore, StepPersistence

from iclip.harness.context_compaction import (
    SUMMARY_FRAMING,
    ContextCompaction,
    compaction_boundary,
    model_window,
    summarizer_input,
)
from iclip.harness.transcript.from_messages import turns_from_messages
from iclip.harness.transcript.projector import step_responses

pytestmark = pytest.mark.unit

SUMMARY = "## Intent\n把 README 翻成英文"

ANCHORED = f"Summary of previous conversation:\n\n{SUMMARY}"
"""摘要器盖在正文前的那句前缀，原样进边界。

它就是摘要器下次认出「上一份摘要」的标记，去掉的话增量更新退化成对摘要再摘要。
"""

WINDOW_HEAD = f"{SUMMARY}\n\n{SUMMARY_FRAMING}"
"""发给模型的窗口首条 user 消息：摘要正文加那句提醒。"""


def _at(minute: int) -> datetime:
    return datetime(2026, 9, 3, 10, minute, tzinfo=UTC)


def _ask(text: str, *, run_id: str = "run-a", minute: int = 0) -> ModelRequest:
    return ModelRequest(parts=[UserPromptPart(content=text)], run_id=run_id, timestamp=_at(minute))


def _reply(text: str, *, run_id: str = "run-a", minute: int = 1) -> ModelResponse:
    return ModelResponse(parts=[TextPart(content=text)], run_id=run_id, timestamp=_at(minute))


def _only_part(message: ModelMessage) -> tuple[type[object], object]:
    """窗口首条那唯一一个 part 的种类与正文。part 自带创建时刻，整条按相等比永远对不上。"""

    assert isinstance(message, ModelRequest)
    assert len(message.parts) == 1
    part = message.parts[0]
    return type(part), getattr(part, "content", None)


def _boundary(summary: str = SUMMARY, *, run_id: str = "run-a", minute: int = 9) -> ModelResponse:
    return ModelResponse(
        parts=[CompactionPart(content=summary, provider_name="function")],
        run_id=run_id,
        timestamp=_at(minute),
    )


# --- model_window ------------------------------------------------------------


def test_没有边界时窗口就是整份历史() -> None:
    messages: list[ModelMessage] = [_ask("一"), _reply("二"), _ask("三")]

    assert model_window(messages) == messages


def test_有边界时窗口是摘要加边界之后那几条() -> None:
    tail = _ask("三")
    window = model_window([_ask("一"), _reply("二"), _boundary(), tail])

    # 摘要是一条 user 消息：做成 system part 会被 chat 适配器排到 instructions 前面去。
    assert _only_part(window[0]) == (UserPromptPart, WINDOW_HEAD)
    # 边界自己不进窗口：它是个标记，不是模型说过的话。
    assert window[1:] == [tail]


def test_两条边界只认最后一条() -> None:
    tail = _ask("四")
    window = model_window(
        [_ask("一"), _boundary("旧摘要", minute=5), _reply("二"), _boundary("新摘要"), tail]
    )

    head = window[0]
    assert isinstance(head, ModelRequest)
    assert isinstance(head.parts[0], UserPromptPart)
    assert head.parts[0].content == f"新摘要\n\n{SUMMARY_FRAMING}"
    assert window[1:] == [tail]


def test_喂给摘要器的那份摘要作system_part() -> None:
    """摘要器认上一份摘要靠的是 system part；给它 user 消息，增量更新退化成对摘要再摘要。"""

    tail = _ask("三")
    fed = summarizer_input([_reply("二"), _boundary(), tail])

    assert _only_part(fed[0]) == (SystemPromptPart, SUMMARY)
    assert fed[1:] == [tail]


def test_边界和旁边那次响应并成一条时照样认得出() -> None:
    """框架发送前会把相邻的同角色消息并成一条，边界于是不再独占一条消息。

    按整条认的话这里会一条边界都找不着，窗口悄悄退回整份历史——压了等于没压，而且不报错。
    同一条里排在边界后面的 part 仍属于窗口。
    """

    tail = _ask("四")
    merged = ModelResponse(
        parts=[CompactionPart(content=SUMMARY, provider_name="function"), TextPart(content="答三")],
        run_id="run-a",
        timestamp=_at(9),
    )
    window = model_window([_ask("一"), _reply("二"), merged, tail])

    assert _only_part(window[0]) == (UserPromptPart, WINDOW_HEAD)
    kept = window[1]
    assert isinstance(kept, ModelResponse)
    assert kept.parts == [TextPart(content="答三")]
    assert window[2:] == [tail]


def test_空parts的响应不是边界() -> None:
    """``all()`` 对空列表为真，漏了这道判断的话空响应会被当成边界，窗口从此只剩一条空摘要。"""

    assert compaction_boundary(ModelResponse(parts=[])) is None


# --- 跑一次真的压缩 ------------------------------------------------------------


def _model(seen: list[list[ModelMessage]]) -> FunctionModel:
    """一个模型两用：提示词里带 ``<messages>`` 的是摘要那次调用，其余是对话本身。"""

    def script(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        seen.append(messages)
        return ModelResponse(parts=[TextPart(SUMMARY if _is_summary_call(messages) else "好了")])

    return FunctionModel(script)


def _is_summary_call(messages: list[ModelMessage]) -> bool:
    return any(
        isinstance(part, UserPromptPart) and "<messages>" in str(part.content)
        for message in messages
        for part in getattr(message, "parts", ())
    )


def _history(rounds: int) -> list[ModelMessage]:
    messages: list[ModelMessage] = []
    for index in range(rounds):
        messages.append(_ask(f"问{index}", run_id=f"run-{index}", minute=index * 2))
        messages.append(_reply(f"答{index}", run_id=f"run-{index}", minute=index * 2 + 1))
    return messages


def _agent(*, max_tokens: int, keep_messages: int, store: InMemoryStepStore) -> Agent[None, str]:
    return Agent(
        _model([]),
        capabilities=[
            ContextCompaction(
                strategy=SummarizingCompaction(
                    max_messages=1, keep_messages=keep_messages, preserve_first_user_message=False
                ),
                max_tokens=max_tokens,
                on_compaction=lambda _summary: None,
            ),
            StepPersistence(store=store),
        ],
    )


async def _latest(store: InMemoryStepStore) -> list[ModelMessage]:
    """这个库里最后一次 run 存下的那份历史。"""

    runs = await store.list_runs()
    snapshot = await store.latest_snapshot(run_id=runs[-1].run_id)
    assert snapshot is not None
    return list(snapshot.messages)


def _turn_shape(messages: list[ModelMessage]) -> list[tuple[str, list[str]]]:
    return [
        (turn.turn_id, [step.step_id for step in turn.steps])
        for turn in turns_from_messages(messages)
    ]


def _notice_ids(messages: list[ModelMessage]) -> list[str]:
    return [
        frame.frame_id
        for turn in turns_from_messages(messages)
        for step in turn.steps
        for frame in step.frames
        if frame.kind == "notice"
    ]


async def _run(
    *, max_tokens: int, keep_messages: int, history: list[ModelMessage]
) -> tuple[list[str], list[list[ModelMessage]], list[ModelMessage], InMemoryStepStore]:
    """跑一轮，返回（回调收到的摘要、模型每次实际收到的消息、最终历史、快照库）。"""

    summaries: list[str] = []
    seen: list[list[ModelMessage]] = []
    store = InMemoryStepStore()
    agent = Agent(
        _model(seen),
        capabilities=[
            ContextCompaction(
                strategy=SummarizingCompaction(
                    max_messages=1, keep_messages=keep_messages, preserve_first_user_message=False
                ),
                max_tokens=max_tokens,
                on_compaction=summaries.append,
            ),
            StepPersistence(store=store),
        ],
    )
    result = await agent.run("接着做", message_history=history)
    return summaries, seen, result.all_messages(), store


def _boundaries(messages: list[ModelMessage]) -> list[ModelResponse]:
    return [
        message
        for message in messages
        if isinstance(message, ModelResponse) and compaction_boundary(message) is not None
    ]


async def test_没到线不压() -> None:
    summaries, seen, history, _ = await _run(
        max_tokens=1_000_000, keep_messages=2, history=_history(3)
    )

    assert summaries == []
    assert _boundaries(history) == []
    # 只叫了一次模型：摘要那次压根没发生。
    assert len(seen) == 1


async def test_过线就在切点插一条边界() -> None:
    prior = _history(4)
    summaries, _, history, _ = await _run(max_tokens=1, keep_messages=2, history=prior)

    boundaries = _boundaries(history)
    assert len(boundaries) == 1
    part = compaction_boundary(boundaries[0])
    assert part is not None
    assert (part.content, part.provider_name) == (ANCHORED, "function")
    # 盖切点那条消息的号，不盖本次 run 的：合并保留前一条的号，盖本次的会把它后面那条响应
    # 连同那一步拽进本轮，早跑完的那一轮当场空掉一步（见 test_压过之后老轮子的步一步不少）。
    assert boundaries[0].run_id == prior[-1].run_id
    # 留 2 条尾巴：切点在「历史最后一条」之前，边界就插在那儿。
    assert history[history.index(boundaries[0]) + 1] == prior[-1]
    assert summaries == [ANCHORED]


async def test_模型只收到窗口那几条() -> None:
    _, seen, history, _ = await _run(max_tokens=1, keep_messages=2, history=_history(4))

    sent = seen[-1]
    assert _only_part(sent[0]) == (UserPromptPart, f"{ANCHORED}\n\n{SUMMARY_FRAMING}")
    boundary = _boundaries(history)[0]
    # 摘要一条 + 边界之后那几条。边界之后到发出去那一刻为止是尾巴加这次的新请求。
    assert len(sent) == 1 + (len(history) - history.index(boundary) - 1 - 1)


async def test_快照存的是全量历史不是窗口() -> None:
    """窗口只该活在那一次请求里。漏进历史的话被摘掉的轮子从此在界面上消失。"""

    prior = _history(4)
    _, _, history, store = await _run(max_tokens=1, keep_messages=2, history=prior)

    run_id = history[-1].run_id
    assert run_id is not None
    snapshot = await store.latest_snapshot(run_id=run_id)
    assert snapshot is not None
    assert snapshot.messages == history
    # 边界之前那几条一条不少：wrap 那一层没把窗口写回历史。
    assert prior[0] in snapshot.messages
    assert len(_boundaries(list(snapshot.messages))) == 1


async def test_第二次压缩带着上一份摘要做增量() -> None:
    """喂给摘要器的那份要让它认出上一份摘要，否则第二次是对摘要再摘要，细节一轮轮磨掉。"""

    _, _, first, _ = await _run(max_tokens=1, keep_messages=2, history=_history(4))
    _, seen, _, _ = await _run(max_tokens=1, keep_messages=2, history=list(first))

    summary_calls = [messages for messages in seen if _is_summary_call(messages)]
    assert len(summary_calls) == 1
    prompt = "\n".join(
        str(part.content)
        for message in summary_calls[0]
        for part in getattr(message, "parts", ())
        if isinstance(part, UserPromptPart)
    )
    assert "<previous-summary>" in prompt
    assert SUMMARY in prompt


async def test_切不动就不压也不回调() -> None:
    """留够尾巴之后没剩下可摘要的：超线也只能原样发出去。"""

    summaries, seen, history, _ = await _run(max_tokens=1, keep_messages=20, history=_history(2))

    assert summaries == []
    assert _boundaries(history) == []
    assert len(seen) == 1


# --- 补用量时认得出哪些响应是自己的 ----------------------------------------------


def test_补用量只认这次run的响应() -> None:
    """边界盖着本次 run 的号，官方的 ``new_messages()`` 因此从边界那一刀切起。

    不筛的话上几轮的响应会漏进来，用量整体错位一格，挂到别人的步上——而且不报错。
    """

    messages: list[ModelMessage] = [
        _boundary(run_id="run-b", minute=9),
        _reply("上一轮的话", run_id="run-a", minute=2),
        _ask("接着做", run_id="run-b", minute=10),
        _reply("这一轮的话", run_id="run-b", minute=11),
    ]

    assert step_responses(messages, "run-b") == [messages[-1]]


def test_不给run号时只摘掉边界() -> None:
    messages: list[ModelMessage] = [_boundary(), _ask("接着做"), _reply("这一轮的话")]

    assert step_responses(messages, None) == [messages[-1]]


async def test_压过之后老轮子的步一步不少() -> None:
    """压过的历史下一轮还要当 message_history 交回引擎，而框架会把边界并进后面那条响应。

    合并保留前一条消息的号。边界要是盖着压缩那次 run 的号，被并进来的那条响应连同它那一步就
    改姓了：早就跑完的那一轮当场空掉一步，界面上刷新一次那一轮就没内容了，而且不报错。
    """

    store = InMemoryStepStore()
    agent = _agent(max_tokens=1, keep_messages=2, store=store)
    await agent.run("接着做", message_history=_history(4))
    first = await _latest(store)
    before = _turn_shape(first)

    # 第二轮拿上一轮的快照当历史，这一轮不再压（线给得很高）。
    later = InMemoryStepStore()
    await _agent(max_tokens=1_000_000, keep_messages=2, store=later).run(
        "再来", message_history=list(first)
    )
    second = await _latest(later)

    assert _turn_shape(second)[: len(before)] == before
    # 边界还认得出来（此时它已并进后面那条响应），提示块没丢。
    assert sum(1 for message in second if compaction_boundary(message) is not None) == 1
    assert _notice_ids(second) == _notice_ids(first)
