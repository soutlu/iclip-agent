"""装配契约：id 即 name、子代理显式声明、空提示词不注入、错误在流之前抛。"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from pydantic_ai import RunContext
from pydantic_ai.capabilities import Capability
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
)
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, DeltaToolCalls, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai_harness.step_persistence import InMemoryStepStore

from iclip.harness.agents import (
    DELEGATE_TOOL,
    AgentDefinition,
    AgentRegistry,
    SubAgentDefinition,
    build_agent_registry,
    delegate_display_table,
)
from iclip.platform.transcript.display import AgentCallDisplay

SPEC = "model: test\n"


MODEL_NAME = "m"


@dataclass(frozen=True)
class Caller:
    """deps 的替身：这一层不认识业务身份，只验穿线本身。

    必须定义在模块级——工具的注解在 ``from __future__ import annotations`` 下
    是字符串，注册工具时按模块全局求值，函数内的局部类解析不到。
    """

    label: str


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


async def drive(registry: AgentRegistry, agent_id: str, *, deps: object = None) -> list[Any]:
    """跑一次，收下全部引擎事件。运行驱动走的也是这条官方入口。"""

    async with registry.agents[agent_id].run_stream_events(
        "hi", conversation_id="c1", run_id="run-1", deps=deps
    ) as events:
        return [event async for event in events]


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

    seen: list[str] = []

    async def note_tools(_messages: list[ModelMessage], info: AgentInfo) -> AsyncIterator[str]:
        seen.extend(tool.name for tool in info.function_tools)
        yield "好"

    with registry.agents["producer"].override(model=FunctionModel(stream_function=note_tools)):
        await drive(registry, "producer")

    assert DELEGATE_TOOL in seen


def test_the_delegate_tool_has_a_display() -> None:
    """派活的卡上画的是「谁在干什么」。

    表里的名字必须就是挂上去的那一件（``DELEGATE_TOOL``），对不上的话派活的卡会退成朴素的
    那张，而且不报错。
    """

    drawn = delegate_display_table()[DELEGATE_TOOL]

    assert drawn({"agent_name": "shot-writer", "task": "写第 3 组"}) == AgentCallDisplay(
        agent_name="shot-writer", prompt="写第 3 组"
    )
    assert drawn({"task": "写第 3 组"}) is None


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
        await drive(registry, "producer")

    runs = await step_store.list_runs()
    # 顶层那次 run 用发起方给的 id 记账（``agent_name`` 因此留空），下属自己铸一个带名字的。
    # 前者是 transcript 分轮的依据：消息上盖的就是这个 id，两边对不上就查不出轮的终态。
    assert [run.run_id for run in runs] == ["run-1", runs[1].run_id]
    assert [run.agent_name for run in runs] == [None, "shot-writer"]
    assert runs[0].conversation_id == "c1"
    assert runs[1].parent_run_id == runs[0].run_id  # 派活谱系无需手工穿线


async def test_subagent_only_gets_the_capabilities_declared_for_it(tmp_path: Path) -> None:
    """隔离是需求，不是巧合：下属看不见主 agent 的能力包工具，反之亦然。

    靠的是官方两个默认值（``inherit_tools`` 为假、``shared_capabilities`` 为空）。
    谁哪天把它们打开，这条就会红。
    """

    def parent_only_tool() -> str:
        """只给主 agent 的工具。"""

        return "父"

    def child_only_tool() -> str:
        """只给下属的工具。"""

        return "子"

    seen: dict[str, tuple[str, ...]] = {}

    async def parent_delegates(
        messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        if len(messages) == 1:
            seen["parent"] = tuple(tool.name for tool in info.function_tools)
            yield {
                0: DeltaToolCall(
                    name="delegate_task",
                    json_args='{"agent_name": "shot-writer", "task": "写三个镜头"}',
                )
            }
        else:
            yield "done"

    async def child_records(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        seen["child"] = tuple(tool.name for tool in info.function_tools)
        return ModelResponse(parts=[TextPart("done")])

    parent = make_spec(tmp_path, "producer")
    child = make_spec(tmp_path, "shot-writer")
    registry = build_agent_registry(
        (
            AgentDefinition(
                agent_id="producer",
                spec=parent,
                model=MODEL_NAME,
                capabilities=(Capability[Any](id="parent-pack", tools=[parent_only_tool]),),
                subagents=(
                    SubAgentDefinition(
                        name="shot-writer",
                        spec=child,
                        model="recorder",
                        capabilities=(Capability[Any](id="child-pack", tools=[child_only_tool]),),
                    ),
                ),
            ),
        ),
        step_store=store(),
        models={MODEL_NAME: TestModel(), "recorder": FunctionModel(child_records)},
    )

    with registry.agents["producer"].override(
        model=FunctionModel(stream_function=parent_delegates)
    ):
        await drive(registry, "producer")

    assert "parent_only_tool" in seen["parent"] and "delegate_task" in seen["parent"]
    assert "child_only_tool" not in seen["parent"]
    assert seen["child"] == ("child_only_tool",)


async def test_run_deps_reach_the_tool(tmp_path: Path) -> None:
    """运行驱动传进来的 deps 一路进到工具的 ``ctx.deps``。

    这一层不认识业务身份，所以用一个替身对象验穿线本身。运行驱动就是这么喂的：
    它按 prompt 行上的属主把主体拼回来，再交给 ``run_stream_events(deps=...)``。
    """

    def whoami(ctx: RunContext[Caller]) -> str:
        """报出当前调用方。"""

        return ctx.deps.label

    spec = make_spec(tmp_path, "storyboard")
    registry = build_agent_registry(
        (
            AgentDefinition(
                agent_id="storyboard",
                spec=spec,
                model=MODEL_NAME,
                capabilities=(Capability[Any](id="identity", tools=[whoami]),),
            ),
        ),
        step_store=store(),
        models=models(),
    )

    events = await drive(registry, "storyboard", deps=Caller("经运行驱动"))
    assert "经运行驱动" in json.dumps([str(event) for event in events], ensure_ascii=False)


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
