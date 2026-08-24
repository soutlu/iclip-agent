"""装配契约：id 即 name、子代理显式声明、空提示词不注入、错误在流之前抛。"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from pydantic_ai.messages import ModelMessage, ModelRequest
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, DeltaToolCalls, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai_harness.step_persistence import InMemoryStepStore

from iclip.common.errors import NotFound, ValidationFailed
from iclip.harness.agents import (
    AgentDefinition,
    AgentRegistry,
    SubAgentDefinition,
    build_agent_registry,
)
from tests.helpers.agui import run_input_bytes

SPEC = "model: test\n"
BODY = run_input_bytes(thread_id="c1")


MODEL_NAME = "m"


def store() -> InMemoryStepStore:
    """本层验装配契约，用内存 store。"""

    return InMemoryStepStore()


def models() -> dict[str, TestModel]:
    """模型用官方 test 替身。"""

    return {MODEL_NAME: TestModel()}


def make_spec(root: Path, name: str, *, spec: str = SPEC, instructions: str | None = None) -> Path:
    folder = root / name
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "agent.yaml"
    path.write_text(spec, encoding="utf-8")
    if instructions is not None:
        (folder / "instructions.md").write_text(instructions, encoding="utf-8")
    return path


def test_empty_definitions_yield_empty_registry() -> None:
    assert build_agent_registry((), step_store=store(), models=models()).ids == ()


def test_agent_id_overrides_spec_name(tmp_path: Path) -> None:
    """spec 里的 name 不得成为运行身份：两个 id 指向同名 spec 也必须可区分。"""

    spec = make_spec(tmp_path, "shared", spec="model: test\nname: shot-writer\n")
    registry = build_agent_registry(
        (
            AgentDefinition(agent_id="storyboard", spec=spec, model=MODEL_NAME),
            AgentDefinition(agent_id="producer", spec=spec, model=MODEL_NAME),
        ),
        step_store=store(),
        models=models(),
    )

    assert registry.ids == ("storyboard", "producer")
    assert registry.agents["storyboard"].name == "storyboard"
    assert registry.agents["producer"].name == "producer"


async def sent_instructions(registry: AgentRegistry, agent_id: str) -> str | None:
    """跑一次，读模型实际收到的指令（公开 API，不碰私有属性）。"""

    request = (await registry.agents[agent_id].run("hi")).all_messages()[0]
    assert isinstance(request, ModelRequest)
    return request.instructions


async def test_instructions_file_merged(tmp_path: Path) -> None:
    spec = make_spec(tmp_path, "storyboard", instructions="写镜头表。")
    registry = build_agent_registry(
        (
            AgentDefinition(
                agent_id="storyboard",
                spec=spec,
                model=MODEL_NAME,
                instructions=spec.parent / "instructions.md",
            ),
        ),
        step_store=store(),
        models=models(),
    )

    assert await sent_instructions(registry, "storyboard") == "写镜头表。"


async def test_blank_instructions_file_injects_nothing(tmp_path: Path) -> None:
    """使用者会先提交空的 instructions.md——空文件不得变成一条空指令。"""

    spec = make_spec(tmp_path, "storyboard", instructions="   \n\n")
    registry = build_agent_registry(
        (
            AgentDefinition(
                agent_id="a",
                spec=spec,
                model=MODEL_NAME,
                instructions=spec.parent / "instructions.md",
            ),
        ),
        step_store=store(),
        models=models(),
    )

    assert await sent_instructions(registry, "a") is None


async def frames(registry: AgentRegistry, agent_id: str, body: bytes = BODY) -> list[str]:
    """跑一次，收下全部编码帧。"""

    return [text async for text, _ in registry.start(agent_id, body).frames]


async def test_subagents_expose_delegate_tool(tmp_path: Path) -> None:
    parent = make_spec(tmp_path, "producer")
    child = make_spec(tmp_path, "shot-writer", spec="model: test\n")
    registry = build_agent_registry(
        (
            AgentDefinition(
                agent_id="producer",
                spec=parent,
                model=MODEL_NAME,
                subagents=(
                    SubAgentDefinition(
                        name="shot-writer",
                        spec=child,
                        model=MODEL_NAME,
                        timeout_seconds=180,
                        max_calls=3,
                    ),
                ),
            ),
        ),
        step_store=store(),
        models=models(),
    )

    body = "".join(await frames(registry, "producer"))
    assert "delegate_task" in body
    assert "shot-writer" in body


async def test_stream_emits_protocol_frames(tmp_path: Path) -> None:
    spec = make_spec(tmp_path, "storyboard")
    registry = build_agent_registry(
        (AgentDefinition(agent_id="storyboard", spec=spec, model=MODEL_NAME),),
        step_store=store(),
        models=models(),
    )

    collected = [(text, last) async for text, last in registry.start("storyboard", BODY).frames]

    # 首帧固定是 RUN_STARTED，并把客户端给的那两个 id 原样带回去。
    first = json.loads(collected[0][0].removeprefix("data: "))
    assert first["type"] == "RUN_STARTED"
    assert (first["threadId"], first["runId"]) == ("c1", "run-1")
    # 只有最后一帧带「结束了」的标记，读的人靠它知道流到头了。
    assert [last for _, last in collected] == [False] * (len(collected) - 1) + [True]


async def test_stream_records_parent_and_subagent_runs(tmp_path: Path) -> None:
    """协议流路径上主 agent 与下属各落一条 run，且父子相连。

    用 ``FunctionModel(stream_function=...)``：官方 ``test`` 模型给 ``delegate_task``
    编的参数是占位串，派不出活。
    """

    async def delegate_once(
        messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        if len(messages) == 1:
            yield {
                0: DeltaToolCall(
                    name="delegate_task",
                    json_args='{"agent_name": "shot-writer", "task": "写三个镜头"}',
                )
            }
        else:
            yield "done"

    parent = make_spec(tmp_path, "producer")
    child = make_spec(tmp_path, "shot-writer")
    step_store = store()
    registry = build_agent_registry(
        (
            AgentDefinition(
                agent_id="producer",
                spec=parent,
                model=MODEL_NAME,
                subagents=(SubAgentDefinition(name="shot-writer", spec=child, model=MODEL_NAME),),
            ),
        ),
        step_store=step_store,
        models=models(),
    )

    with registry.agents["producer"].override(model=FunctionModel(stream_function=delegate_once)):
        await frames(registry, "producer")

    runs = await step_store.list_runs()
    assert [run.agent_name for run in runs] == ["producer", "shot-writer"]
    assert runs[0].conversation_id == "c1"  # 协议请求体的 threadId 即会话 id
    assert runs[1].parent_run_id == runs[0].run_id  # 派活谱系无需手工穿线


def test_unknown_id_raises_not_found_before_streaming(tmp_path: Path) -> None:
    registry = build_agent_registry((), step_store=store(), models=models())
    with pytest.raises(NotFound, match="未注册的 agent"):
        registry.start("ghost", BODY)


def test_malformed_body_raises_validation_failed_before_streaming(tmp_path: Path) -> None:
    spec = make_spec(tmp_path, "storyboard")
    registry = build_agent_registry(
        (AgentDefinition(agent_id="storyboard", spec=spec, model=MODEL_NAME),),
        step_store=store(),
        models=models(),
    )
    with pytest.raises(ValidationFailed):
        registry.start("storyboard", b'{"nope": true}')


def test_unknown_model_name_fails_at_assembly(tmp_path: Path) -> None:
    """引用未声明的模型名即装配期报错。"""

    spec = make_spec(tmp_path, "storyboard")
    with pytest.raises(RuntimeError, match="未声明的模型"):
        build_agent_registry(
            (AgentDefinition(agent_id="storyboard", spec=spec, model="ghost"),),
            step_store=store(),
            models=models(),
        )


def test_unknown_subagent_model_name_fails_at_assembly(tmp_path: Path) -> None:
    parent = make_spec(tmp_path, "producer")
    child = make_spec(tmp_path, "shot-writer")
    with pytest.raises(RuntimeError, match="未声明的模型"):
        build_agent_registry(
            (
                AgentDefinition(
                    agent_id="producer",
                    spec=parent,
                    model=MODEL_NAME,
                    subagents=(SubAgentDefinition(name="shot-writer", spec=child, model="ghost"),),
                ),
            ),
            step_store=store(),
            models=models(),
        )


def test_spec_model_field_is_overridden(tmp_path: Path) -> None:
    """spec 里的 model 被声明覆盖。"""

    spec = make_spec(tmp_path, "storyboard", spec="model: no-such-provider:no-such-model\n")
    registry = build_agent_registry(
        (AgentDefinition(agent_id="storyboard", spec=spec, model=MODEL_NAME),),
        step_store=store(),
        models=models(),
    )

    assert isinstance(registry.agents["storyboard"].model, TestModel)
