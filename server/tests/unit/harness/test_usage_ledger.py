"""用量台账：模型每答一次记一笔到（对话，模型），写不进去不影响运行。"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field

import pytest
from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.usage import RequestUsage

from iclip.harness.usage_ledger import UsageLedger
from iclip.platform.transcript.ops import StepUsage

pytestmark = pytest.mark.unit


@dataclass(frozen=True)
class Deps:
    conversation_id: str | None


@dataclass
class RecordingStore:
    rows: dict[tuple[str, str], list[StepUsage]] = field(default_factory=dict)

    async def add(self, *, conversation_id: str, model_name: str, usage: StepUsage) -> None:
        self.rows.setdefault((conversation_id, model_name), []).append(usage)


class BrokenStore:
    async def add(self, *, conversation_id: str, model_name: str, usage: StepUsage) -> None:
        raise RuntimeError("库连不上")


def _answer(_messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
    # 显式给用量，FunctionModel 才不会按正文长度估一份出来。
    return ModelResponse(
        parts=[TextPart("好")],
        usage=RequestUsage(
            input_tokens=100, cache_read_tokens=30, cache_write_tokens=10, output_tokens=7
        ),
    )


def _conversation_of(deps: object) -> str | None:
    return deps.conversation_id if isinstance(deps, Deps) else None


def _agent(store: RecordingStore | BrokenStore, *, model_name: str = "m") -> Agent[Deps, str]:
    return Agent(
        FunctionModel(_answer, model_name=model_name),
        deps_type=Deps,
        capabilities=[UsageLedger(store=store, conversation_of=_conversation_of)],
    )


async def test_each_response_is_recorded_under_its_conversation_and_model() -> None:
    store = RecordingStore()
    agent = _agent(store)

    await agent.run("一", deps=Deps("c1"))
    await agent.run("二", deps=Deps("c1"))
    await agent.run("三", deps=Deps("c2"))

    assert {key: len(rows) for key, rows in store.rows.items()} == {("c1", "m"): 2, ("c2", "m"): 1}
    # input_tokens 含缓存读写，普通输入要扣掉两者，和 transcript 界面显示的一致。
    assert store.rows[("c1", "m")][0] == StepUsage(
        input_other=60, output=7, input_cache_read=30, input_cache_creation=10
    )


async def test_model_name_comes_from_the_configured_model() -> None:
    store = RecordingStore()

    await _agent(store, model_name="qwen3-max").run("一", deps=Deps("c1"))
    await _agent(store, model_name="qwen3-plus").run("二", deps=Deps("c1"))

    assert set(store.rows) == {("c1", "qwen3-max"), ("c1", "qwen3-plus")}


async def test_a_response_without_a_conversation_is_not_recorded() -> None:
    store = RecordingStore()

    await _agent(store).run("一", deps=Deps(None))

    assert store.rows == {}


async def test_a_failing_store_does_not_fail_the_run() -> None:
    result = await _agent(BrokenStore()).run("一", deps=Deps("c1"))

    assert result.output == "好"


async def _stream_answer(_messages: list[ModelMessage], _info: AgentInfo) -> AsyncIterator[str]:
    yield "好"
    yield "的"


async def test_streamed_responses_are_recorded_once_with_their_final_usage() -> None:
    """运行器走 run_stream_events；流式响应合并成一条后才进 wrap_model_request，只记一笔。"""

    store = RecordingStore()
    agent: Agent[Deps, str] = Agent(
        FunctionModel(stream_function=_stream_answer, model_name="m"),
        deps_type=Deps,
        capabilities=[UsageLedger(store=store, conversation_of=_conversation_of)],
    )

    async with agent.run_stream_events("一", deps=Deps("c1")) as events:
        async for _event in events:
            pass

    (recorded,) = store.rows[("c1", "m")]
    assert recorded.output > 0
