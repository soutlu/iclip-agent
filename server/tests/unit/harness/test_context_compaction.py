"""验证压缩边界保留完整历史，仅在模型请求时生成压缩窗口。"""

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
"""摘要前缀用于识别上一份摘要，须原样保留在边界中以支持增量压缩。"""

WINDOW_HEAD = f"{SUMMARY}\n\n{SUMMARY_FRAMING}"
"""模型窗口首条 user 消息，包含摘要及提示。"""


def _at(minute: int) -> datetime:
    return datetime(2026, 9, 3, 10, minute, tzinfo=UTC)


def _ask(text: str, *, run_id: str = "run-a", minute: int = 0) -> ModelRequest:
    return ModelRequest(parts=[UserPromptPart(content=text)], run_id=run_id, timestamp=_at(minute))


def _reply(text: str, *, run_id: str = "run-a", minute: int = 1) -> ModelResponse:
    return ModelResponse(parts=[TextPart(content=text)], run_id=run_id, timestamp=_at(minute))


def _only_part(message: ModelMessage) -> tuple[type[object], object]:
    """提取首个 part 的类型与正文，忽略每次创建时不同的时间戳。"""

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


def test_没有边界时窗口就是整份历史() -> None:
    messages: list[ModelMessage] = [_ask("一"), _reply("二"), _ask("三")]

    assert model_window(messages) == messages


def test_有边界时窗口是摘要加边界之后那几条() -> None:
    tail = _ask("三")
    window = model_window([_ask("一"), _reply("二"), _boundary(), tail])

    # 对话摘要使用 user part，避免 chat 适配器将其排在 instructions 之前。
    assert _only_part(window[0]) == (UserPromptPart, WINDOW_HEAD)
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
    """摘要器通过 system part 识别已有摘要；user part 会导致重复摘要。"""

    tail = _ask("三")
    fed = summarizer_input([_reply("二"), _boundary(), tail])

    assert _only_part(fed[0]) == (SystemPromptPart, SUMMARY)
    assert fed[1:] == [tail]


def test_边界和旁边那次响应并成一条时照样认得出() -> None:
    """同角色消息会合并，需按 part 识别边界，并保留同一消息中边界后的内容。"""

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
    """all([]) 为真；必须排除空响应，避免误认压缩边界。"""

    assert compaction_boundary(ModelResponse(parts=[])) is None


def _model(seen: list[list[ModelMessage]]) -> FunctionModel:
    """以 <messages> 标记区分摘要请求与对话请求。"""

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
    """返回回调摘要、模型实际输入、完整历史和快照库。"""

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
    assert len(seen) == 1


async def test_过线就在切点插一条边界() -> None:
    prior = _history(4)
    summaries, _, history, _ = await _run(max_tokens=1, keep_messages=2, history=prior)

    boundaries = _boundaries(history)
    assert len(boundaries) == 1
    part = compaction_boundary(boundaries[0])
    assert part is not None
    assert (part.content, part.provider_name) == (ANCHORED, "function")
    # 边界继承切点消息的 run_id，避免合并后将历史响应归入本轮。
    assert boundaries[0].run_id == prior[-1].run_id
    assert history[history.index(boundaries[0]) + 1] == prior[-1]
    assert summaries == [ANCHORED]


async def test_模型只收到窗口那几条() -> None:
    _, seen, history, _ = await _run(max_tokens=1, keep_messages=2, history=_history(4))

    sent = seen[-1]
    assert _only_part(sent[0]) == (UserPromptPart, f"{ANCHORED}\n\n{SUMMARY_FRAMING}")
    boundary = _boundaries(history)[0]
    assert len(sent) == 1 + (len(history) - history.index(boundary) - 1 - 1)


async def test_快照存的是全量历史不是窗口() -> None:
    """持久化完整历史；模型窗口写回快照会导致旧轮内容丢失。"""

    prior = _history(4)
    _, _, history, store = await _run(max_tokens=1, keep_messages=2, history=prior)

    run_id = history[-1].run_id
    assert run_id is not None
    snapshot = await store.latest_snapshot(run_id=run_id)
    assert snapshot is not None
    assert snapshot.messages == history
    assert prior[0] in snapshot.messages
    assert len(_boundaries(list(snapshot.messages))) == 1


async def test_第二次压缩带着上一份摘要做增量() -> None:

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
    """保留尾部后无可摘要内容时，超出阈值也不执行压缩。"""

    summaries, seen, history, _ = await _run(max_tokens=1, keep_messages=20, history=_history(2))

    assert summaries == []
    assert _boundaries(history) == []
    assert len(seen) == 1


def test_补用量只认这次run的响应() -> None:
    """new_messages 可能包含边界后的历史响应，用量补充必须按当前 run_id 过滤。"""

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
    """框架合并边界和后续响应时保留前者 run_id；边界须使用切点 id，避免历史步骤改属本轮。"""

    store = InMemoryStepStore()
    agent = _agent(max_tokens=1, keep_messages=2, store=store)
    await agent.run("接着做", message_history=_history(4))
    first = await _latest(store)
    before = _turn_shape(first)

    # 复用压缩后的快照，并提高阈值避免第二轮再次压缩。
    later = InMemoryStepStore()
    await _agent(max_tokens=1_000_000, keep_messages=2, store=later).run(
        "再来", message_history=list(first)
    )
    second = await _latest(later)

    assert _turn_shape(second)[: len(before)] == before
    assert sum(1 for message in second if compaction_boundary(message) is not None) == 1
    assert _notice_ids(second) == _notice_ids(first)
