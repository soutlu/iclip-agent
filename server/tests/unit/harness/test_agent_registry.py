"""装配契约：id 即 name、子代理显式声明、空提示词不注入、错误在流之前抛。"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from pydantic_ai import RunContext
from pydantic_ai.capabilities import Capability
from pydantic_ai.messages import (
    ImageUrl,
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)
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
from iclip.harness.media import MediaCodec
from tests.helpers.agui import run_input_bytes

SPEC = "model: test\n"
BODY = run_input_bytes(thread_id="c1")


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
    assert (
        build_agent_registry((), step_store=store(), models=models(), media=MediaCodec()).ids == ()
    )


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
        media=MediaCodec(),
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
        media=MediaCodec(),
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
        media=MediaCodec(),
    )

    assert await sent_instructions(registry, "a") is None


def deps_stub(value: object = None) -> Callable[[str, str], Awaitable[object]]:
    """造依赖的替身：宿主在真身里要读库，所以这个回调是可等待的。"""

    async def _deps(_conversation_id: str, _run_id: str) -> object:
        return value

    return _deps


async def frames(registry: AgentRegistry, agent_id: str, body: bytes = BODY) -> list[str]:
    """跑一次，收下全部编码帧。"""

    handle = await registry.start(agent_id, body, deps_stub())
    return [text async for text, _ in handle.frames]


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
        media=MediaCodec(),
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
        media=MediaCodec(),
    )

    handle = await registry.start("storyboard", BODY, deps_stub())
    collected = [(text, last) async for text, last in handle.frames]

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
        media=MediaCodec(),
    )

    with registry.agents["producer"].override(model=FunctionModel(stream_function=delegate_once)):
        await frames(registry, "producer")

    runs = await step_store.list_runs()
    # 顶层那次 run 用发起方给的 id 记账（``agent_name`` 因此留空），下属自己铸一个带名字的。
    # 前者是 transcript 分轮的依据：消息上盖的就是这个 id，两边对不上就查不出轮的终态。
    assert [run.run_id for run in runs] == ["run-1", runs[1].run_id]
    assert [run.agent_name for run in runs] == [None, "shot-writer"]
    assert runs[0].conversation_id == "c1"  # 协议请求体的 threadId 即会话 id
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
        media=MediaCodec(),
    )

    with registry.agents["producer"].override(
        model=FunctionModel(stream_function=parent_delegates)
    ):
        await frames(registry, "producer")

    assert "parent_only_tool" in seen["parent"] and "delegate_task" in seen["parent"]
    assert "child_only_tool" not in seen["parent"]
    assert seen["child"] == ("child_only_tool",)


async def test_run_deps_reach_the_tool(tmp_path: Path) -> None:
    """``start`` 收到的 deps 一路进到工具的 ``ctx.deps``。

    这一层不认识业务身份，所以用一个替身对象验穿线本身。工具替身用官方的
    ``override(deps=...)``（官方给的 deps 测试接口）另测一遍：装配好的 agent
    不经协议面也能喂 deps，说明工具不依赖那条路径。
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
        media=MediaCodec(),
    )

    # 协议面这条路：deps 由 start 传入。
    handle = await registry.start("storyboard", BODY, deps_stub(Caller("经协议面")))
    body = "".join([text async for text, _ in handle.frames])
    assert "经协议面" in body

    # 官方的 deps 覆写这条路：同一个 agent，不经协议面。
    agent = registry.agents["storyboard"]
    with agent.override(deps=Caller("经官方覆写")):
        result = await agent.run("你是谁")
    assert "经官方覆写" in str(result.output)


async def test_unknown_id_raises_not_found_before_streaming(tmp_path: Path) -> None:
    registry = build_agent_registry((), step_store=store(), models=models(), media=MediaCodec())
    with pytest.raises(NotFound, match="未注册的 agent"):
        await registry.start("ghost", BODY, deps_stub())


async def test_empty_thread_id_raises_validation_failed_before_streaming(tmp_path: Path) -> None:
    """协议把 threadId 标成必填，但空串照样过 pydantic。

    会话 id 是要拿去分隔离段的（工作区就按它分文件夹），空的当不了段。所以在这
    一层——拥有协议的这一层——就拒掉，而不是让它一路漂到某个存储层去报一句看不懂
    的话。这里就位也意味着它发生在开流之前，客户端拿到的是一个正常的错误响应。
    """

    spec = make_spec(tmp_path, "storyboard")
    registry = build_agent_registry(
        (AgentDefinition(agent_id="storyboard", spec=spec, model=MODEL_NAME),),
        step_store=store(),
        models=models(),
        media=MediaCodec(),
    )
    called: list[tuple[str, str]] = []

    async def recording_deps(conversation_id: str, run_id: str) -> object:
        called.append((conversation_id, run_id))
        return None

    with pytest.raises(ValidationFailed, match="threadId"):
        await registry.start("storyboard", run_input_bytes(thread_id=""), recording_deps)
    # 拒在造依赖之前：宿主的回调根本没被调用过。
    assert called == []


async def test_malformed_body_raises_validation_failed_before_streaming(tmp_path: Path) -> None:
    spec = make_spec(tmp_path, "storyboard")
    registry = build_agent_registry(
        (AgentDefinition(agent_id="storyboard", spec=spec, model=MODEL_NAME),),
        step_store=store(),
        models=models(),
        media=MediaCodec(),
    )
    with pytest.raises(ValidationFailed):
        await registry.start("storyboard", b'{"nope": true}', deps_stub())


def test_unknown_model_name_fails_at_assembly(tmp_path: Path) -> None:
    """引用未声明的模型名即装配期报错。"""

    spec = make_spec(tmp_path, "storyboard")
    with pytest.raises(RuntimeError, match="未声明的模型"):
        build_agent_registry(
            (AgentDefinition(agent_id="storyboard", spec=spec, model="ghost"),),
            step_store=store(),
            models=models(),
            media=MediaCodec(),
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
            media=MediaCodec(),
        )


def test_spec_model_field_is_overridden(tmp_path: Path) -> None:
    """spec 里的 model 被声明覆盖。"""

    spec = make_spec(tmp_path, "storyboard", spec="model: no-such-provider:no-such-model\n")
    registry = build_agent_registry(
        (AgentDefinition(agent_id="storyboard", spec=spec, model=MODEL_NAME),),
        step_store=store(),
        models=models(),
        media=MediaCodec(),
    )

    assert isinstance(registry.agents["storyboard"].model, TestModel)


async def test_media_parts_reach_the_model_as_tags(tmp_path: Path) -> None:
    """带附件的请求体到不了模型面：视频换成一行地址，图片额外留一份像素。

    这条守的是改写挂在了协议入口上。挂漏了的话，视频会一路走到模型适配层才炸
    （官方 OpenAI 模型对视频 URL 直接抛），那时已经开了流，只能变成流中途的报错。
    """

    seen: list[list[ModelMessage]] = []

    async def capture(messages: list[ModelMessage], _info: AgentInfo) -> AsyncIterator[str]:
        seen.append(messages)
        yield "ok"

    spec = make_spec(tmp_path, "producer")
    registry = build_agent_registry(
        (AgentDefinition(agent_id="producer", spec=spec, model=MODEL_NAME),),
        step_store=store(),
        models=models(),
        media=MediaCodec(),
    )
    body = run_input_bytes(
        thread_id="c1",
        content=[
            {"type": "text", "text": "参考这个片子"},
            {
                "type": "video",
                "source": {"type": "url", "value": "https://oss/ref.mp4", "mimeType": "video/mp4"},
                "metadata": {"filename": "ref.mp4"},
            },
            {
                "type": "image",
                "source": {
                    "type": "url",
                    "value": "https://bucket.oss-cn-hangzhou.aliyuncs.com/style.jpg",
                    "mimeType": "image/jpeg",
                },
            },
        ],
    )

    with registry.agents["producer"].override(model=FunctionModel(stream_function=capture)):
        await frames(registry, "producer", body)

    prompt = seen[0][0].parts[0]
    assert isinstance(prompt, UserPromptPart)
    assert prompt.content == [
        "参考这个片子",
        '<video url="https://oss/ref.mp4" name="ref.mp4"></video>',
        '<image url="https://bucket.oss-cn-hangzhou.aliyuncs.com/style.jpg">',
        ImageUrl(
            url="https://bucket.oss-cn-hangzhou.aliyuncs.com/style.jpg"
            "?x-oss-process=image/resize,l_1024",
            media_type="image/jpeg",
        ),
        "</image>",
    ]
