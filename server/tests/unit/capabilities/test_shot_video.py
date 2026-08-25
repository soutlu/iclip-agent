"""镜头素材能力：工具面的语义、出图的重试与升级、装配面接得上。

出图、对象存储、视频拆解都用进程内替身（`tests/helpers/shot_video.py`），所以
这一层测的是「工具怎么决策」，不是 ffmpeg 也不是真的生成后端。碰 ffmpeg 的那两
件工具在这里只验它们在动手之前就把坏参数拦下来了——真跑一遍在集成层。
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from pydantic_ai import Agent, ModelRetry
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import RunContext
from pydantic_ai.usage import RunUsage

from iclip.capabilities.shot_video.capability import (
    CAPABILITY_ID,
    MAX_FRAMES_PER_CALL,
    GenerationPolicy,
    ShotVideo,
    ShotVideoToolset,
    shot_video_capability,
)
from iclip.capabilities.shot_video.parser import (
    SYSTEM_PROMPT,
    ArkVideoUnderstanding,
    VideoUnderstandingError,
)
from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.identity.models import Principal
from tests.helpers.shot_video import (
    FakeGenerations,
    FakeObjects,
    FakeUnderstanding,
    Outcome,
)

USER = uuid.UUID("11111111-1111-1111-1111-111111111111")
VIDEO = "https://cdn.test/ref.mp4"
IMAGE = "https://cdn.test/grid.png"

# 替身不碰网络也不起子进程，把节奏压到最小，测试就不会真的睡上几秒。
FAST = GenerationPolicy(
    poll_interval_seconds=0.001,
    backoff_seconds=0.001,
    backoff_factor=1.0,
    total_timeout_seconds=5.0,
)


def make_deps() -> AgentRunDeps:
    return AgentRunDeps(
        principal=Principal(
            kind="user",
            user_id=USER,
            permissions=frozenset({"agent:run"}),
            audit_label="luke",
            api_key_id=None,
        ),
        conversation_id="thread-1",
    )


def make_context(deps: object) -> RunContext[object]:
    return RunContext[object](deps=deps, model=TestModel(), usage=RunUsage())


@pytest.fixture
def generations() -> FakeGenerations:
    return FakeGenerations()


@pytest.fixture
def objects() -> FakeObjects:
    return FakeObjects()


@pytest.fixture
def understanding() -> FakeUnderstanding:
    return FakeUnderstanding()


@pytest.fixture
def capability(
    generations: FakeGenerations, objects: FakeObjects, understanding: FakeUnderstanding
) -> ShotVideo[object]:
    return shot_video_capability(
        generations=generations,
        objects=objects,
        understanding=understanding,
        client=None,  # type: ignore[arg-type]  # 这一层不走取素材那条路
        policy=FAST,
    )


@pytest.fixture
def tools(capability: ShotVideo[object]) -> ShotVideoToolset[object]:
    toolset = capability.get_toolset()
    assert isinstance(toolset, ShotVideoToolset)
    return toolset


@pytest.fixture
def ctx() -> RunContext[object]:
    return make_context(make_deps())


# ── 装配面 ────────────────────────────────────────────────────────────────────


def test_capability_id_is_fixed(capability: ShotVideo[object]) -> None:
    """id 写死：官方按 id 认能力，派生值会让每次运行看起来像另一个能力。"""

    assert capability.id == CAPABILITY_ID
    toolset = capability.get_toolset()
    assert isinstance(toolset, ShotVideoToolset)
    assert toolset.id == CAPABILITY_ID


def test_not_constructible_from_spec() -> None:
    """三个依赖都是运行期对象，YAML 里造不出来——所以不对外宣称能反序列化。"""

    assert ShotVideo.get_serialization_name() is None


def test_no_capability_instructions(capability: ShotVideo[object]) -> None:
    """不注入指令：这几件工具怎么接力是流程知识，归 skill，不归能力包。"""

    assert capability.get_instructions() is None


async def test_four_tools_reach_the_model(capability: ShotVideo[object]) -> None:
    """挂到真 Agent 上：四件工具都出现在模型看得到的工具表里。"""

    seen: list[str] = []

    def script(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        _ = messages
        seen.extend(sorted(tool.name for tool in info.function_tools))
        return ModelResponse(parts=[TextPart("好")])

    agent = Agent(FunctionModel(script), capabilities=[capability])
    await agent.run("看看你有什么", deps=make_deps())
    assert seen == ["cut_grid_image", "extract_video_frames", "generate_image", "parse_video"]


async def test_missing_run_identity_is_a_bug_not_a_retry(
    tools: ShotVideoToolset[object],
) -> None:
    """deps 不对是装配出错，不该翻成一句让模型重试的话——它改不动这个。"""

    with pytest.raises(RuntimeError, match="AgentRunDeps"):
        await tools.parse_video(make_context(object()), VIDEO)


# ── 视频拆解 ──────────────────────────────────────────────────────────────────


async def test_parse_video_returns_the_document(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    understanding: FakeUnderstanding,
) -> None:
    """文档直接回给模型，不落任何约定路径的暗账文件。"""

    result = await tools.parse_video(ctx, VIDEO)
    assert result == understanding.document
    assert understanding.calls == [VIDEO]


async def test_parse_video_translates_failure(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    understanding: FakeUnderstanding,
) -> None:
    understanding.error = VideoUnderstandingError("接口连不上")
    with pytest.raises(ModelRetry, match="连不上"):
        await tools.parse_video(ctx, VIDEO)


@pytest.mark.parametrize("url", ["ref.mp4", "file:///etc/passwd", "ftp://host/a.mp4"])
async def test_tools_only_take_http_urls(
    tools: ShotVideoToolset[object], ctx: RunContext[object], url: str
) -> None:
    with pytest.raises(ModelRetry, match="http"):
        await tools.parse_video(ctx, url)


# ── 视频拆解接口的响应处理 ────────────────────────────────────────────────────


def ark(handler: Callable[[httpx.Request], httpx.Response]) -> ArkVideoUnderstanding:
    return ArkVideoUnderstanding(
        httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        url="https://vision.test/responses",
        api_key="ark",
        model="seed-vision",
    )


def responses_body(status: str = "completed", text: str = "## 4、逐镜拉片表\n……") -> dict[str, Any]:
    """对方成功时的真实形状：先一段 reasoning，再一段 message。"""

    return {
        "status": status,
        "output": [
            {"type": "reasoning", "content": []},
            {"type": "message", "content": [{"type": "output_text", "text": text}]},
        ],
    }


async def test_parser_takes_the_output_text_and_skips_reasoning() -> None:
    understanding = ark(lambda _: httpx.Response(200, json=responses_body()))
    assert await understanding.parse(VIDEO) == "## 4、逐镜拉片表\n……"


@pytest.mark.parametrize("status", ["incomplete", "in_progress", "failed"])
async def test_parser_refuses_a_response_that_did_not_finish(status: str) -> None:
    """撞上输出长度上限时对方照样返 200，正文却缺了尾巴。

    把那半份文档交出去，下游会从一张被截断的镜头表里挑时间码，而且没人知道少了
    一段——所以宁可失败，并把对方说的状态原样带出来。
    """

    understanding = ark(lambda _: httpx.Response(200, json=responses_body(status=status)))
    with pytest.raises(VideoUnderstandingError, match=status):
        await understanding.parse(VIDEO)


async def test_parser_refuses_an_empty_document() -> None:
    understanding = ark(lambda _: httpx.Response(200, json={"status": "completed", "output": []}))
    with pytest.raises(VideoUnderstandingError, match="没给出正文"):
        await understanding.parse(VIDEO)


async def test_parser_reports_the_upstream_error_body() -> None:
    understanding = ark(
        lambda _: httpx.Response(400, json={"error": {"message": "video_url 取不到"}})
    )
    with pytest.raises(VideoUnderstandingError, match="400"):
        await understanding.parse(VIDEO)


async def test_parser_refuses_a_non_json_body() -> None:
    understanding = ark(lambda _: httpx.Response(200, text="<html>502</html>"))
    with pytest.raises(VideoUnderstandingError, match="不是 JSON"):
        await understanding.parse(VIDEO)


async def test_parser_sends_the_video_as_a_native_part() -> None:
    """系统提示词 + input_video + input_text 是这家接口收得下的形状。"""

    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        assert request.headers["Authorization"] == "Bearer ark"
        return httpx.Response(200, json=responses_body())

    await ark(handler).parse(VIDEO)
    roles = [message["role"] for message in seen["input"]]
    assert roles == ["system", "user"]
    assert seen["input"][0]["content"][0]["text"] == SYSTEM_PROMPT
    assert seen["input"][1]["content"][0] == {"type": "input_video", "video_url": VIDEO}
    assert seen["model"] == "seed-vision"


# ── 抽帧与切格：动手之前就把坏参数拦下 ──────────────────────────────────────


@pytest.mark.parametrize(
    "timestamps",
    [[], ["3.8"], ["00:03,800"], ["00:60.000"], ["abc"], ["00:03.800"] * (MAX_FRAMES_PER_CALL + 1)],
    ids=["empty", "no-colon", "comma", "bad-seconds", "text", "too-many"],
)
async def test_frame_timestamps_are_checked_first(
    tools: ShotVideoToolset[object], ctx: RunContext[object], timestamps: list[str]
) -> None:
    """替身里没有 HTTP 客户端，所以能走到这里就证明它没先去取素材。"""

    with pytest.raises(ModelRetry):
        await tools.extract_video_frames(ctx, VIDEO, timestamps)


@pytest.mark.parametrize(("rows", "cols"), [(0, 2), (2, 0), (7, 2), (2, 7)])
async def test_grid_side_is_checked_first(
    tools: ShotVideoToolset[object], ctx: RunContext[object], rows: int, cols: int
) -> None:
    with pytest.raises(ModelRetry, match="rows"):
        await tools.cut_grid_image(ctx, IMAGE, rows=rows, cols=cols)


# ── 出图：重试与升级 ─────────────────────────────────────────────────────────


async def test_generate_image_happy_path(
    tools: ShotVideoToolset[object], ctx: RunContext[object], generations: FakeGenerations
) -> None:
    result = await tools.generate_image(ctx, "一只猫", "16:9")
    assert "https://cdn.test/out.png" in result
    assert generations.channels() == ["dev"]


async def test_generate_image_retries_only_what_never_arrived(
    tools: ShotVideoToolset[object], ctx: RunContext[object], generations: FakeGenerations
) -> None:
    """连不上是确定没计费的失败，重发一次是安全的。"""

    generations.outcomes = [
        Outcome(status="failed", output_url=None, error_code="PROVIDER_UNREACHABLE"),
        Outcome(),
    ]
    result = await tools.generate_image(ctx, "一只猫", "16:9")
    assert "https://cdn.test/out.png" in result
    assert generations.channels() == ["dev", "dev"]
    # 试过的那次也要说出来：它是一行真实的生成记录。
    assert "PROVIDER_UNREACHABLE" in result


async def test_generate_image_escalates_to_pro_after_dev(
    tools: ShotVideoToolset[object], ctx: RunContext[object], generations: FakeGenerations
) -> None:
    generations.outcomes = [
        Outcome(status="failed", output_url=None, error_code="PROVIDER_UNREACHABLE"),
        Outcome(status="failed", output_url=None, error_code="PROVIDER_SERVER_ERROR"),
        Outcome(),
    ]
    result = await tools.generate_image(ctx, "一只猫", "16:9")
    assert generations.channels() == ["dev", "dev", "pro"]
    assert "https://cdn.test/out.png" in result


@pytest.mark.parametrize(
    "error_code",
    [
        "PROVIDER_RESULT_UNKNOWN",
        "PROVIDER_REJECTED",
        "PROVIDER_MALFORMED",
        "OUTPUT_STORE_FAILED",
        "OUTPUT_DOWNLOAD_FAILED",
        "SUBMIT_INTERRUPTED",
        "PROVIDER_TIMEOUT",
    ],
)
async def test_generate_image_stops_where_money_may_already_be_spent(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    generations: FakeGenerations,
    error_code: str,
) -> None:
    """这些失败都可能已经计费（或再发一次也是同样答复），一次都不许自动重发。"""

    generations.outcomes = [Outcome(status="failed", output_url=None, error_code=error_code)]
    result = await tools.generate_image(ctx, "一只猫", "16:9")
    assert generations.channels() == ["dev"]
    assert error_code in result


async def test_generate_image_exhausts_every_channel_then_reports(
    tools: ShotVideoToolset[object], ctx: RunContext[object], generations: FakeGenerations
) -> None:
    generations.outcomes = [
        Outcome(status="failed", output_url=None, error_code="PROVIDER_UNREACHABLE")
    ]
    result = await tools.generate_image(ctx, "一只猫", "16:9")
    assert generations.channels() == ["dev", "dev", "pro"]
    assert "失败" in result


async def test_generate_image_rejects_bad_parameters_before_paying(
    tools: ShotVideoToolset[object], ctx: RunContext[object], generations: FakeGenerations
) -> None:
    """参数不合规是在提交之前拒的，一分钱没花，所以让模型改了重来。"""

    with pytest.raises(ModelRetry, match="aspect_ratio"):
        await tools.generate_image(ctx, "一只猫", "17:9")
    assert generations.submitted == []


async def test_generate_image_reference_urls_must_be_http(
    tools: ShotVideoToolset[object], ctx: RunContext[object], generations: FakeGenerations
) -> None:
    with pytest.raises(ModelRetry, match="参考图"):
        await tools.generate_image(ctx, "一只猫", "16:9", reference_image_urls=["grid.png"])
    assert generations.submitted == []


async def test_generate_image_gives_up_waiting_but_names_the_record(
    ctx: RunContext[object], generations: FakeGenerations, objects: FakeObjects
) -> None:
    """等超时不等于这次生成没了：把记录 id 报回去，人还能自己去查。"""

    generations.outcomes = [Outcome(status="submitted", output_url=None)]
    toolset = shot_video_capability(
        generations=generations,
        objects=objects,
        understanding=FakeUnderstanding(),
        client=None,  # type: ignore[arg-type]
        policy=GenerationPolicy(
            poll_interval_seconds=0.001,
            dev_attempts=1,
            pro_attempts=0,
            backoff_seconds=0.001,
            total_timeout_seconds=0.02,
        ),
    ).get_toolset()
    assert isinstance(toolset, ShotVideoToolset)
    result = await toolset.generate_image(ctx, "一只猫", "16:9")
    assert "TOOL_WAIT_TIMEOUT" in result
    assert str(generations.job_ids[0]) in result
