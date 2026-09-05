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
from pydantic_ai.messages import ModelMessage, ModelRequest
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
from iclip.harness.transcript.store import TranscriptStore
from iclip.harness.transcript.subagents import SubAgentMirror
from iclip.platform.transcript.display import AgentCallDisplay

SPEC = "model: test\n"


MODEL_NAME = "m"


@dataclass(frozen=True)
class Caller:
    """测试 deps 类型，验证依赖传递。

    类型须定义在模块级，以便框架解析延迟求值的工具注解。
    """

    label: str


def store() -> InMemoryStepStore:

    return InMemoryStepStore()


def models() -> dict[str, TestModel]:

    return {MODEL_NAME: TestModel()}


def mirror() -> SubAgentMirror:

    return SubAgentMirror(live=TranscriptStore())


def make_spec(root: Path, name: str, *, spec: str = SPEC, instructions: str | None = None) -> Path:
    folder = root / name
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "agent.yaml"
    path.write_text(spec, encoding="utf-8")
    if instructions is not None:
        (folder / "instructions.md").write_text(instructions, encoding="utf-8")
    return path


def test_empty_definitions_yield_empty_registry() -> None:
    registry = build_agent_registry(
        (), step_store=store(), models=models(), subagent_mirror=mirror()
    )

    assert registry.ids == ()


def test_agent_id_overrides_spec_name(tmp_path: Path) -> None:

    spec = make_spec(tmp_path, "shared", spec="model: test\nname: shot-writer\n")
    registry = build_agent_registry(
        (
            AgentDefinition(agent_id="storyboard", spec=spec, model=MODEL_NAME),
            AgentDefinition(agent_id="producer", spec=spec, model=MODEL_NAME),
        ),
        step_store=store(),
        models=models(),
        subagent_mirror=mirror(),
    )

    assert registry.ids == ("storyboard", "producer")
    assert registry.agents["storyboard"].name == "storyboard"
    assert registry.agents["producer"].name == "producer"


async def sent_instructions(registry: AgentRegistry, agent_id: str) -> str | None:
    """执行 Agent 并读取模型实际接收的指令。"""

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
        subagent_mirror=mirror(),
    )

    assert await sent_instructions(registry, "storyboard") == "写镜头表。"


async def test_blank_instructions_file_injects_nothing(tmp_path: Path) -> None:

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
        subagent_mirror=mirror(),
    )

    assert await sent_instructions(registry, "a") is None


async def drive(registry: AgentRegistry, agent_id: str, *, deps: object = None) -> list[Any]:
    """通过 run_stream_events 收集完整运行事件。"""

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
        subagent_mirror=mirror(),
    )

    seen: list[str] = []

    async def note_tools(_messages: list[ModelMessage], info: AgentInfo) -> AsyncIterator[str]:
        seen.extend(tool.name for tool in info.function_tools)
        yield "好"

    with registry.agents["producer"].override(model=FunctionModel(stream_function=note_tools)):
        await drive(registry, "producer")

    assert DELEGATE_TOOL in seen


def test_the_delegate_tool_has_a_display() -> None:
    """display 注册名须与实际挂载的 DELEGATE_TOOL 一致，避免错误回退到 generic。"""

    drawn = delegate_display_table()[DELEGATE_TOOL]

    assert drawn({"agent_name": "shot-writer", "task": "写第 3 组"}) == AgentCallDisplay(
        agent_name="shot-writer", prompt="写第 3 组"
    )
    assert drawn({"task": "写第 3 组"}) is None


async def test_stream_records_parent_and_subagent_runs(tmp_path: Path) -> None:
    """使用 FunctionModel 提供有效派发参数；TestModel 的占位参数无法调用子代理。"""

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
        subagent_mirror=mirror(),
    )

    with registry.agents["producer"].override(model=FunctionModel(stream_function=delegate_once)):
        await drive(registry, "producer")

    runs = await step_store.list_runs()
    # 顶层与子代理都不设 agent_name，落库 id 与消息 run_id 一致；子代理的名字放 metadata。
    assert [run.run_id for run in runs] == ["run-1", runs[1].run_id]
    assert [run.agent_name for run in runs] == [None, None]
    assert runs[1].metadata["agent_name"] == "shot-writer"
    assert runs[0].conversation_id == "c1"
    assert runs[1].parent_run_id == runs[0].run_id


async def test_subagent_only_gets_the_capabilities_declared_for_it(tmp_path: Path) -> None:
    """保留 inherit_tools=False，shared_capabilities 只有不带工具的 transcript 镜像。"""

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

    async def child_records(messages: list[ModelMessage], info: AgentInfo) -> AsyncIterator[str]:
        seen["child"] = tuple(tool.name for tool in info.function_tools)
        yield "done"

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
        # 挂了 transcript 镜像的子代理一律走流式，模型须提供 stream_function。
        models={
            MODEL_NAME: TestModel(),
            "recorder": FunctionModel(stream_function=child_records),
        },
        subagent_mirror=mirror(),
    )

    with registry.agents["producer"].override(
        model=FunctionModel(stream_function=parent_delegates)
    ):
        await drive(registry, "producer")

    assert "parent_only_tool" in seen["parent"] and "delegate_task" in seen["parent"]
    assert "child_only_tool" not in seen["parent"]
    assert seen["child"] == ("child_only_tool",)


async def test_run_deps_reach_the_tool(tmp_path: Path) -> None:
    """通过替身 deps 验证 run_stream_events 到工具 ctx.deps 的传递。"""

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
        subagent_mirror=mirror(),
    )

    events = await drive(registry, "storyboard", deps=Caller("经运行驱动"))
    assert "经运行驱动" in json.dumps([str(event) for event in events], ensure_ascii=False)


def test_unknown_model_name_fails_at_assembly(tmp_path: Path) -> None:

    spec = make_spec(tmp_path, "storyboard")
    with pytest.raises(RuntimeError, match="未声明的模型"):
        build_agent_registry(
            (AgentDefinition(agent_id="storyboard", spec=spec, model="ghost"),),
            step_store=store(),
            models=models(),
            subagent_mirror=mirror(),
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
            subagent_mirror=mirror(),
        )


def test_spec_model_field_is_overridden(tmp_path: Path) -> None:

    spec = make_spec(tmp_path, "storyboard", spec="model: no-such-provider:no-such-model\n")
    registry = build_agent_registry(
        (AgentDefinition(agent_id="storyboard", spec=spec, model=MODEL_NAME),),
        step_store=store(),
        models=models(),
        subagent_mirror=mirror(),
    )

    assert isinstance(registry.agents["storyboard"].model, TestModel)
