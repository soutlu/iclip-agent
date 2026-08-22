"""装配契约：id 即 name、子代理显式声明、空提示词不注入、错误在流之前抛。"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic_ai.messages import ModelRequest

from iclip.common.errors import NotFound, ValidationFailed
from iclip.harness.agents import (
    AgentDefinition,
    AgentRegistry,
    SubAgentDefinition,
    build_agent_registry,
)

SPEC = "model: test\n"
BODY = (
    b'{"trigger":"submit-message","id":"c1",'
    b'"messages":[{"id":"m1","role":"user","parts":[{"type":"text","text":"hi"}]}]}'
)


def make_spec(root: Path, name: str, *, spec: str = SPEC, instructions: str | None = None) -> Path:
    folder = root / name
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "agent.yaml"
    path.write_text(spec, encoding="utf-8")
    if instructions is not None:
        (folder / "instructions.md").write_text(instructions, encoding="utf-8")
    return path


def test_empty_definitions_yield_empty_registry() -> None:
    assert build_agent_registry(()).ids == ()


def test_agent_id_overrides_spec_name(tmp_path: Path) -> None:
    """spec 里的 name 不得成为运行身份：两个 id 指向同名 spec 也必须可区分。"""

    spec = make_spec(tmp_path, "shared", spec="model: test\nname: shot-writer\n")
    registry = build_agent_registry(
        (
            AgentDefinition(agent_id="storyboard", spec=spec),
            AgentDefinition(agent_id="producer", spec=spec),
        )
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
                agent_id="storyboard", spec=spec, instructions=spec.parent / "instructions.md"
            ),
        )
    )

    assert await sent_instructions(registry, "storyboard") == "写镜头表。"


async def test_blank_instructions_file_injects_nothing(tmp_path: Path) -> None:
    """使用者会先提交空的 instructions.md——空文件不得变成一条空指令。"""

    spec = make_spec(tmp_path, "storyboard", instructions="   \n\n")
    registry = build_agent_registry(
        (AgentDefinition(agent_id="a", spec=spec, instructions=spec.parent / "instructions.md"),)
    )

    assert await sent_instructions(registry, "a") is None


async def test_subagents_expose_delegate_tool(tmp_path: Path) -> None:
    parent = make_spec(tmp_path, "producer")
    child = make_spec(tmp_path, "shot-writer", spec="model: test\n")
    registry = build_agent_registry(
        (
            AgentDefinition(
                agent_id="producer",
                spec=parent,
                subagents=(
                    SubAgentDefinition(
                        name="shot-writer", spec=child, timeout_seconds=180, max_calls=3
                    ),
                ),
            ),
        )
    )

    frames = "".join([f async for f in registry.stream("producer", BODY, None)])
    assert "delegate_task" in frames
    assert "shot-writer" in frames


async def test_stream_emits_protocol_frames(tmp_path: Path) -> None:
    spec = make_spec(tmp_path, "storyboard")
    registry = build_agent_registry((AgentDefinition(agent_id="storyboard", spec=spec),))

    frames = [f async for f in registry.stream("storyboard", BODY, None)]

    assert frames[0] == 'data: {"type":"start"}\n\n'
    assert len(frames) > 1


def test_unknown_id_raises_not_found_before_streaming(tmp_path: Path) -> None:
    registry = build_agent_registry(())
    with pytest.raises(NotFound, match="未注册的 agent"):
        registry.stream("ghost", BODY, None)


def test_malformed_body_raises_validation_failed_before_streaming(tmp_path: Path) -> None:
    spec = make_spec(tmp_path, "storyboard")
    registry = build_agent_registry((AgentDefinition(agent_id="storyboard", spec=spec),))
    with pytest.raises(ValidationFailed):
        registry.stream("storyboard", b'{"nope": true}', None)


def test_missing_model_in_spec_fails_at_assembly(tmp_path: Path) -> None:
    """装配期冻结：spec 声明了不存在的模型，启动就炸，不留到首个请求。"""

    spec = make_spec(tmp_path, "broken", spec="model: no-such-provider:no-such-model\n")
    with pytest.raises(Exception, match="no-such-provider"):
        build_agent_registry((AgentDefinition(agent_id="broken", spec=spec),))
