"""使用内存替身验证镜头素材工具、生成重试与能力装配；ffmpeg 执行由集成测试覆盖。"""

from __future__ import annotations

import inspect
import json
import uuid
from collections.abc import Callable
from dataclasses import replace
from typing import Any

import httpx
import pytest
from pydantic_ai import Agent, ModelRetry
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ToolCallPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import RunContext
from pydantic_ai.usage import RunUsage

from iclip.capabilities.shot_video.capability import (
    CAPABILITY_ID,
    GenerationPolicy,
    ShotVideo,
    shot_video_capability,
)
from iclip.capabilities.shot_video.delivery import (
    SHOTS_PATH,
    FrameRequest,
    VideoShotRequest,
    validate_video_shots_document,
)
from iclip.capabilities.shot_video.extraction import EXTRACTION_PATH, video_doc_path
from iclip.capabilities.shot_video.generation import ANCHOR_ASPECT, GRID_RESOLUTION
from iclip.capabilities.shot_video.parser import (
    SYSTEM_PROMPT,
    ArkVideoUnderstanding,
    VideoUnderstandingError,
)
from iclip.capabilities.shot_video.toolset import ShotVideoToolset
from iclip.capabilities.workspace.scope import workspace_namespace
from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.identity.models import Principal
from iclip.platform.file_store.store import FileSpace
from iclip.platform.material_ledger.store import Material
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.transcript.display import GenericDisplay, ToolDisplayRegistry
from tests.helpers.file_store import FakeFileStore
from tests.helpers.material_ledger import FakeMaterialLedger
from tests.helpers.shot_video import (
    FakeGenerations,
    FakeObjects,
    FakeUnderstanding,
    Outcome,
)

USER = uuid.UUID("11111111-1111-1111-1111-111111111111")
VIDEO = "https://cdn.test/ref.mp4"
NAMESPACE = f"{USER}/thread-1"

DOCUMENT = (
    "## 4、逐镜拉片表\n"
    "| 结构层级 | Storyline |\n"
    "| Rain-Step Hook | **[00:00.000-00:02.000]** 中景……<br><br>"
    "**[00:02.000-00:04.000]** 特写…… |\n"
)

# 替身无网络或子进程操作，缩短轮询间隔以减少测试等待。
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

    return RunContext[object](deps=deps, model=TestModel(), usage=RunUsage(), messages=[])


def ledger(*cell_ids: str) -> str:
    """仅包含逐格请求校验字段的取帧账本。"""

    return json.dumps(
        {
            "extractionVersion": 1,
            "extractionKey": "k",
            "intervalMs": 1000,
            "video": {"url": VIDEO, "contentHash": "sha256:x"},
            "boards": [
                {
                    "board": 1,
                    "url": "https://cdn.test/board.jpg",
                    "shots": [1],
                    "layout": "2x2",
                    "cells": [{"id": cell, "shotId": 1} for cell in cell_ids],
                }
            ],
            "shotsWithoutCells": [],
        }
    )


@pytest.fixture
def generations() -> FakeGenerations:
    return FakeGenerations()


@pytest.fixture
def objects() -> FakeObjects:
    return FakeObjects()


@pytest.fixture
def understanding() -> FakeUnderstanding:
    return FakeUnderstanding(document=DOCUMENT)


@pytest.fixture
def files() -> FakeFileStore:
    return FakeFileStore()


@pytest.fixture
def materials() -> FakeMaterialLedger:
    """模拟参考视频已在收件阶段登记。"""

    fake = FakeMaterialLedger()
    fake.rows[(NAMESPACE, VIDEO)] = Material(url=VIDEO, kind="video")
    return fake


@pytest.fixture
def capability(
    files: FakeFileStore,
    materials: FakeMaterialLedger,
    generations: FakeGenerations,
    objects: FakeObjects,
    understanding: FakeUnderstanding,
) -> ShotVideo[object]:
    return shot_video_capability(
        space=FileSpace(store=files, namespace=workspace_namespace),
        ledger=materials,
        generations=generations,
        objects=objects,
        paths=MEDIA_PATHS,
        understanding=understanding,
        client=None,  # type: ignore[arg-type]  # 本测试不调用素材下载。
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


async def check_args(
    tools: ShotVideoToolset[object], name: str, ctx: RunContext[object], **args: Any
) -> None:
    """通过工具注册表调用校验器，覆盖 args_validator 的挂载遗漏。"""

    validator = tools.tools[name].args_validator
    assert validator is not None, f"{name} 登记时没挂验证器"
    outcome = validator(ctx, **args)
    assert inspect.isawaitable(outcome), "本包的验证器都是 async 的"
    await outcome


def test_capability_id_is_fixed(capability: ShotVideo[object]) -> None:
    """固定 id 保持框架在不同运行中对能力身份的识别。"""

    assert capability.id == CAPABILITY_ID
    toolset = capability.get_toolset()
    assert isinstance(toolset, ShotVideoToolset)
    assert toolset.id == CAPABILITY_ID


def test_not_constructible_from_spec() -> None:
    """能力依赖运行时对象，无法从 YAML 反序列化。"""

    assert ShotVideo.get_serialization_name() is None


def test_no_capability_instructions(capability: ShotVideo[object]) -> None:
    """工具协作流程由 skill 描述，能力包不重复注入指令。"""

    assert capability.get_instructions() is None


async def test_every_tool_reaches_the_model(capability: ShotVideo[object]) -> None:

    seen: list[str] = []

    def script(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        _ = messages
        seen.extend(sorted(tool.name for tool in info.function_tools))
        return ModelResponse(parts=[TextPart("好")])

    agent = Agent(FunctionModel(script), capabilities=[capability])
    await agent.run("看看你有什么", deps=make_deps())
    assert seen == [
        "generate_anchor_sheet",
        "generate_shot_frames",
        "plan_shot_frames",
        "video_parser_md",
        "write_video_shots",
    ]


@pytest.mark.parametrize(
    "tool_name",
    ["video_parser_md", "plan_shot_frames", "generate_shot_frames", "write_video_shots"],
)
def test_scope_rules_are_mounted_on_the_tool(
    tools: ShotVideoToolset[object], tool_name: str
) -> None:
    """校验器单测无法发现挂载遗漏，需检查工具注册表的 args_validator。"""

    assert tools.tools[tool_name].args_validator is not None


def test_every_tool_has_a_display(capability: ShotVideo[object]) -> None:

    drawn = ToolDisplayRegistry.merged(capability.display_table()).entries
    assert sorted(drawn) == [
        "generate_anchor_sheet",
        "generate_shot_frames",
        "plan_shot_frames",
        "video_parser_md",
        "write_video_shots",
    ]
    # 标题是书面动宾短语，主语是镜头号；张数进结果角标，不进标题。
    assert drawn["generate_shot_frames"].draw(
        {"frames": [{"no": "S2-1"}, {"no": "S1-3"}, {"no": "S2-2"}]}
    ) == GenericDisplay(summary="生成画面", detail="镜头 1、2")
    assert drawn["generate_shot_frames"].draw(None) == GenericDisplay(summary="生成画面")
    assert drawn["write_video_shots"].draw({}) == GenericDisplay(
        summary="保存分镜", detail=SHOTS_PATH
    )
    assert drawn["video_parser_md"].draw({"video_url": VIDEO}) == GenericDisplay(
        summary="拆解视频", detail="ref.mp4"
    )
    assert drawn["video_parser_md"].draw({}) == GenericDisplay(summary="拆解视频")
    assert drawn["plan_shot_frames"].draw({"video_url": VIDEO}) == GenericDisplay(
        summary="提取候选帧", detail="ref.mp4"
    )
    assert drawn["generate_anchor_sheet"].draw({}) == GenericDisplay(summary="生成设定图")


def test_only_the_three_media_tools_pick_a_renderer(capability: ShotVideo[object]) -> None:

    views = ToolDisplayRegistry.merged(capability.display_table())
    for tool_name in ("plan_shot_frames", "generate_shot_frames", "generate_anchor_sheet"):
        assert views.view_of(tool_name) == "media_grid"
    for tool_name in ("video_parser_md", "write_video_shots"):
        assert views.view_of(tool_name) is None


async def test_an_out_of_scope_address_is_refused_on_the_agent_path(
    capability: ShotVideo[object], understanding: FakeUnderstanding
) -> None:
    """通过真实 Agent 确认未登记地址在工具执行前被拒绝。"""

    def call_once(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        if len(messages) == 1:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        "video_parser_md",
                        {"video_url": "https://cdn.test/made-up.mp4"},
                        tool_call_id="c1",
                    )
                ]
            )
        return ModelResponse(parts=[TextPart("好")])

    agent = Agent(FunctionModel(call_once), capabilities=[capability])
    result = await agent.run("帮我拆一下", deps=make_deps())

    refusals = [
        part
        for message in result.all_messages()
        for part in message.parts
        if isinstance(part, RetryPromptPart)
    ]
    assert len(refusals) == 1
    assert "不是这段对话里的素材" in refusals[0].model_response()
    assert understanding.calls == []


async def test_missing_run_identity_is_a_bug_not_a_retry(tools: ShotVideoToolset[object]) -> None:
    """deps 类型错误属于装配故障，模型重试无法修复。"""

    with pytest.raises(RuntimeError, match="AgentRunDeps"):
        await tools.video_parser_md(make_context(object()), VIDEO)


async def test_files_land_in_the_normalized_namespace(
    objects: FakeObjects, understanding: FakeUnderstanding, files: FakeFileStore
) -> None:
    """共享 FileSpace 的能力必须使用归一化命名空间，否则工作区工具无法读取产物。"""

    toolset = shot_video_capability(
        space=FileSpace(store=files, namespace=lambda _ctx: f"{USER}//thread-1"),
        ledger=FakeMaterialLedger(),
        generations=FakeGenerations(),
        objects=objects,
        paths=MEDIA_PATHS,
        understanding=understanding,
        client=None,  # type: ignore[arg-type]  # 本测试不调用素材下载。
        policy=FAST,
    ).get_toolset()
    assert isinstance(toolset, ShotVideoToolset)

    result = await toolset.video_parser_md(make_context(make_deps()), VIDEO)
    assert await files.read(NAMESPACE, result["path"]) is not None


async def test_parse_writes_the_document_and_returns_its_path(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    understanding: FakeUnderstanding,
    files: FakeFileStore,
) -> None:
    """拆解文档持久化供后续工具读取，返回路径以避免重复占用上下文。"""

    result = await tools.video_parser_md(ctx, VIDEO)
    assert result["path"] == video_doc_path(VIDEO)
    assert understanding.calls == [VIDEO]
    stored = await files.read(NAMESPACE, result["path"])
    assert stored is not None
    assert stored.content == DOCUMENT


async def test_parse_and_plan_agree_on_where_the_document_lives(
    tools: ShotVideoToolset[object], ctx: RunContext[object], understanding: FakeUnderstanding
) -> None:
    """使用无时间码文档触发解析错误，以确认取帧工具读取了拆解工具写入的文件。"""

    understanding.document = "## 4、逐镜拉片表\n没有任何时间码\n"
    await tools.video_parser_md(ctx, VIDEO)
    with pytest.raises(ModelRetry, match="解析失败"):
        await tools.plan_shot_frames(ctx, VIDEO)


def test_document_path_survives_two_videos_of_the_same_name() -> None:

    assert video_doc_path("https://a.test/ref.mp4") != video_doc_path("https://b.test/ref.mp4")


async def test_parse_translates_failure(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    understanding: FakeUnderstanding,
) -> None:
    understanding.error = VideoUnderstandingError("接口连不上")
    with pytest.raises(ModelRetry, match="连不上"):
        await tools.video_parser_md(ctx, VIDEO)


@pytest.mark.parametrize("url", ["ref.mp4", "file:///etc/passwd", "ftp://host/a.mp4"])
async def test_tools_only_take_http_urls(
    tools: ShotVideoToolset[object], ctx: RunContext[object], url: str
) -> None:
    with pytest.raises(ModelRetry, match="http"):
        await check_args(tools, "video_parser_md", ctx, video_url=url)


@pytest.mark.parametrize("tool_name", ["video_parser_md", "plan_shot_frames"])
async def test_video_tools_refuse_an_address_the_conversation_never_had(
    tools: ShotVideoToolset[object], ctx: RunContext[object], tool_name: str
) -> None:
    """素材范围校验必须先于视频下载，避免请求未登记的地址。"""

    with pytest.raises(ModelRetry, match="不是这段对话里的素材") as failure:
        await check_args(tools, tool_name, ctx, video_url="https://cdn.test/made-up.mp4")

    # 不回显未登记地址，避免重试消息将其引入素材上下文。
    assert "made-up" not in str(failure.value)


async def test_video_tools_refuse_an_image_the_user_sent(
    tools: ShotVideoToolset[object], ctx: RunContext[object], materials: FakeMaterialLedger
) -> None:

    image = "https://cdn.test/poster.jpg"
    materials.rows[(NAMESPACE, image)] = Material(url=image, kind="image")
    with pytest.raises(ModelRetry, match="图片"):
        await check_args(tools, "plan_shot_frames", ctx, video_url=image)


async def test_reference_images_refuse_a_video(
    tools: ShotVideoToolset[object], ctx: RunContext[object]
) -> None:

    with pytest.raises(ModelRetry, match="视频"):
        await check_args(
            tools,
            "generate_shot_frames",
            ctx,
            frames=[FrameRequest(no="S1-1", prompt="猫")],
            reference_images=[VIDEO],
            global_reference="全局",
            target_aspect="9:16",
        )


async def test_reference_images_take_an_address_the_tools_wrote_down(
    tools: ShotVideoToolset[object], ctx: RunContext[object], materials: FakeMaterialLedger
) -> None:

    frame = "https://bucket.oss-cn-hangzhou.aliyuncs.com/shot-frames/k/S1-1.jpg"
    materials.rows[(NAMESPACE, frame)] = Material(url=frame, kind="image")

    async def call(url: str) -> None:
        await check_args(
            tools,
            "generate_shot_frames",
            ctx,
            frames=[FrameRequest(no="S1-1", prompt="猫")],
            reference_images=[url],
            global_reference="全局",
            target_aspect="9:16",
        )

    await call(frame)
    with pytest.raises(ModelRetry, match="不是这段对话里的素材"):
        await call("https://bucket.oss-cn-hangzhou.aliyuncs.com/shot-frames/k/S9-9.jpg")


def ark(
    handler: Callable[[httpx.Request], httpx.Response],
    *,
    thinking: str | None = None,
    fps: float | None = None,
) -> ArkVideoUnderstanding:
    return ArkVideoUnderstanding(
        httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        url="https://vision.test/responses",
        api_key="ark",
        model="seed-vision",
        thinking=thinking,
        fps=fps,
    )


def responses_body(status: str = "completed", text: str = "## 4、逐镜拉片表\n……") -> dict[str, Any]:
    """包含 reasoning 和 message 的成功响应。"""

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
    """输出被截断时接口仍可能返回 200，需校验完成状态以避免交付残缺镜头表。"""

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
    assert "reasoning" not in seen, "没配思考强度就不发这个参数，交给对方默认档"


async def test_parser_sends_the_configured_reasoning_effort() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(200, json=responses_body())

    await ark(handler, thinking="medium").parse(VIDEO)
    assert seen["reasoning"] == {"effort": "medium"}


async def test_parser_sends_the_configured_fps_on_the_video_part() -> None:

    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(200, json=responses_body())

    await ark(handler, fps=5).parse(VIDEO)
    assert seen["input"][1]["content"][0] == {"type": "input_video", "video_url": VIDEO, "fps": 5}


async def test_plan_needs_the_document_first(
    tools: ShotVideoToolset[object], ctx: RunContext[object]
) -> None:
    """替身不提供 HTTP 客户端；缺少文档时应在下载前失败。"""

    with pytest.raises(ModelRetry, match="video_parser_md"):
        await tools.plan_shot_frames(ctx, VIDEO)


async def test_plan_points_at_a_repair_the_model_can_perform(
    tools: ShotVideoToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> None:

    await files.write(NAMESPACE, video_doc_path(VIDEO), "## 4、逐镜拉片表\n没有任何时间码\n")
    with pytest.raises(ModelRetry) as raised:
        await tools.plan_shot_frames(ctx, VIDEO)
    assert "edit_file" in str(raised.value)


async def test_plan_rejects_a_document_with_a_broken_timecode(
    tools: ShotVideoToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> None:
    """结束时间不晚于开始时间时无法取帧，应在下载和抽帧前拒绝。"""

    await files.write(NAMESPACE, video_doc_path(VIDEO), "**[00:05.000-00:02.000]** 中景")
    with pytest.raises(ModelRetry, match="终点不晚于起点"):
        await tools.plan_shot_frames(ctx, VIDEO)


async def test_generate_needs_the_extraction_ledger(
    tools: ShotVideoToolset[object], ctx: RunContext[object], generations: FakeGenerations
) -> None:
    with pytest.raises(ModelRetry, match="plan_shot_frames"):
        await tools.generate_shot_frames(
            ctx, [FrameRequest(no="S1-1", prompt="猫")], [], "全局", "9:16"
        )
    assert generations.submitted == []


@pytest.mark.parametrize(
    ("frames", "expected"),
    [
        ([], "1-4"),
        ([FrameRequest(no=f"S1-{index}", prompt="猫") for index in range(1, 6)], "1-4"),
        ([FrameRequest(no="8-3", prompt="猫")], "形状"),
        ([FrameRequest(no="S1-1", prompt="猫"), FrameRequest(no="S1-1", prompt="狗")], "重复"),
        ([FrameRequest(no="S1-1", prompt="  ")], "为空"),
    ],
    ids=["empty", "too-many", "bad-shape", "duplicate", "blank-prompt"],
)
async def test_generate_checks_every_cell_before_paying(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    generations: FakeGenerations,
    frames: list[FrameRequest],
    expected: str,
) -> None:
    await files.write(NAMESPACE, EXTRACTION_PATH, ledger("S1-1", "S1-2", "S1-3", "S1-4"))
    with pytest.raises(ModelRetry, match=expected):
        await tools.generate_shot_frames(ctx, frames, [], "全局", "9:16")
    assert generations.submitted == []


async def test_generate_accepts_a_frame_the_ledger_never_sampled(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    generations: FakeGenerations,
) -> None:
    """新增镜头或不足一秒的镜头可能没有候选帧，仍应允许生成定格。"""

    generations.outcomes = [
        Outcome(status="failed", output_url=None, error_code="PROVIDER_REJECTED")
    ]
    await files.write(NAMESPACE, EXTRACTION_PATH, ledger("S1-1"))
    await tools.generate_shot_frames(
        ctx, [FrameRequest(no="S9-2", prompt="猫")], [], "全局", "9:16"
    )
    assert generations.submitted


async def test_generate_tags_the_job_with_the_conversation(
    tools: ShotVideoToolset[object],
    files: FakeFileStore,
    generations: FakeGenerations,
) -> None:

    conversation_id = str(uuid.uuid4())
    ctx = make_context(replace(make_deps(), conversation_id=conversation_id))
    # 使用失败结果避免进入切格流程，本测试仅检查提交字段。
    generations.outcomes = [Outcome(status="failed", output_url=None, error_code="REJECTED")]
    await files.write(f"{USER}/{conversation_id}", EXTRACTION_PATH, ledger("S1-1"))
    await tools.generate_shot_frames(
        ctx, [FrameRequest(no="S1-1", prompt="猫")], [], "全局", "9:16"
    )
    await tools.generate_anchor_sheet(ctx, ["一只猫"])

    assert {request.conversation_id for request in generations.submitted} == {conversation_id}


async def test_generate_leaves_the_conversation_empty_when_it_is_not_an_id(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    generations: FakeGenerations,
) -> None:

    generations.outcomes = [Outcome(status="failed", output_url=None, error_code="REJECTED")]
    await files.write(NAMESPACE, EXTRACTION_PATH, ledger("S1-1"))
    await tools.generate_shot_frames(
        ctx, [FrameRequest(no="S1-1", prompt="猫")], [], "全局", "9:16"
    )

    assert generations.submitted[0].conversation_id is None


async def test_generate_reference_urls_must_be_http(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    generations: FakeGenerations,
) -> None:
    with pytest.raises(ModelRetry, match="参考图"):
        await check_args(
            tools,
            "generate_shot_frames",
            ctx,
            frames=[FrameRequest(no="S1-1", prompt="猫")],
            reference_images=["grid.png"],
            global_reference="全局",
            target_aspect="9:16",
        )
    assert generations.submitted == []


async def test_generate_refuses_an_empty_global_reference(
    tools: ShotVideoToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> None:
    await files.write(NAMESPACE, EXTRACTION_PATH, ledger("S1-1"))
    with pytest.raises(ModelRetry, match="global_reference"):
        await tools.generate_shot_frames(
            ctx, [FrameRequest(no="S1-1", prompt="猫")], [], "  ", "9:16"
        )


async def submit_once(
    tools: ShotVideoToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> dict[str, Any]:
    """提交一次生成；使用失败结果避免依赖 ffmpeg 切格。"""

    await files.write(NAMESPACE, EXTRACTION_PATH, ledger("S1-1"))
    result = await tools.generate_shot_frames(
        ctx, [FrameRequest(no="S1-1", prompt="猫")], [], "全局参考", "9:16"
    )
    assert isinstance(result, dict)
    return result


async def test_generate_submits_a_full_grid_at_the_top_tier(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    generations: FakeGenerations,
) -> None:
    """单格也使用完整四格网格；最高分辨率保证切分后单格尺寸。"""

    generations.outcomes = [
        Outcome(status="failed", output_url=None, error_code="PROVIDER_REJECTED")
    ]
    await submit_once(tools, ctx, files)
    request = generations.submitted[0]
    assert request.resolution == GRID_RESOLUTION
    assert request.aspect_ratio == "9:16"
    assert "全局参考" in request.prompt
    assert request.prompt.count("visual_prompt:") == 4


async def test_generate_escalates_to_pro_after_dev(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    generations: FakeGenerations,
) -> None:
    generations.outcomes = [
        Outcome(status="failed", output_url=None, error_code="PROVIDER_UNREACHABLE")
    ]
    result = await submit_once(tools, ctx, files)
    assert generations.channels() == ["dev", "dev", "pro"]
    assert result["status"] == "failed"
    assert result["frames"] == []


@pytest.mark.parametrize(
    "error_code",
    [
        "PROVIDER_REJECTED",
        "PROVIDER_GENERATION_FAILED",
        "PROVIDER_RESULT_UNKNOWN",
        "PROVIDER_MALFORMED",
        "PROVIDER_OUTPUT_MISSING",
        "OUTPUT_STORE_FAILED",
        "OUTPUT_DOWNLOAD_FAILED",
        "SUBMIT_INTERRUPTED",
        "PROVIDER_TIMEOUT",
    ],
)
async def test_generate_walks_every_channel_on_any_failure(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    generations: FakeGenerations,
    error_code: str,
) -> None:

    generations.outcomes = [Outcome(status="failed", output_url=None, error_code=error_code)]
    result = await submit_once(tools, ctx, files)
    assert generations.channels() == ["dev", "dev", "pro"]
    assert error_code in result["error"]


async def test_generate_stays_on_dev_when_pro_is_off(
    ctx: RunContext[object],
    generations: FakeGenerations,
    objects: FakeObjects,
    files: FakeFileStore,
) -> None:

    generations.outcomes = [
        Outcome(status="failed", output_url=None, error_code="PROVIDER_REJECTED")
    ]
    toolset = shot_video_capability(
        space=FileSpace(store=files, namespace=workspace_namespace),
        ledger=FakeMaterialLedger(),
        generations=generations,
        objects=objects,
        paths=MEDIA_PATHS,
        understanding=FakeUnderstanding(),
        client=None,  # type: ignore[arg-type]
        policy=GenerationPolicy(
            poll_interval_seconds=0.001, dev_attempts=2, pro_attempts=0, backoff_seconds=0.001
        ),
    ).get_toolset()
    assert isinstance(toolset, ShotVideoToolset)
    result = await submit_once(toolset, ctx, files)
    assert generations.channels() == ["dev", "dev"]
    assert "PROVIDER_REJECTED" in result["error"]


async def test_generate_rejects_bad_parameters_before_paying(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    generations: FakeGenerations,
) -> None:
    """非法参数应在付费提交前拒绝，供模型修正。"""

    await files.write(NAMESPACE, EXTRACTION_PATH, ledger("S1-1"))
    with pytest.raises(ModelRetry, match="aspect_ratio"):
        await tools.generate_shot_frames(
            ctx, [FrameRequest(no="S1-1", prompt="猫")], [], "全局", "17:9"
        )
    assert generations.submitted == []


async def test_generate_gives_up_waiting_but_names_the_record(
    ctx: RunContext[object],
    generations: FakeGenerations,
    objects: FakeObjects,
    files: FakeFileStore,
) -> None:
    """等待超时需返回记录 id；总时限耗尽后不再提交下一次生成。"""

    generations.outcomes = [Outcome(status="submitted", output_url=None)]
    toolset = shot_video_capability(
        space=FileSpace(store=files, namespace=workspace_namespace),
        ledger=FakeMaterialLedger(),
        generations=generations,
        objects=objects,
        paths=MEDIA_PATHS,
        understanding=FakeUnderstanding(),
        client=None,  # type: ignore[arg-type]
        policy=GenerationPolicy(
            poll_interval_seconds=0.001,
            dev_attempts=1,
            pro_attempts=1,
            backoff_seconds=0.001,
            total_timeout_seconds=0.02,
        ),
    ).get_toolset()
    assert isinstance(toolset, ShotVideoToolset)
    result = await submit_once(toolset, ctx, files)
    assert generations.channels() == ["dev"]
    assert "TOOL_WAIT_TIMEOUT" in result["error"]
    assert str(generations.job_ids[0]) in result["error"]


@pytest.mark.parametrize(
    ("cells", "message"),
    [
        ([], "1-4"),
        (["人"] * 5, "1-4"),
        (["人", "   "], "第 2 格"),
    ],
)
async def test_anchor_sheet_rejects_bad_cells_before_paying(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    generations: FakeGenerations,
    cells: list[str],
    message: str,
) -> None:

    with pytest.raises(ModelRetry, match=message):
        await tools.generate_anchor_sheet(ctx, cells)
    assert generations.submitted == []


async def test_anchor_sheet_submits_a_full_square_grid_without_references(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    generations: FakeGenerations,
) -> None:

    generations.outcomes = [
        Outcome(status="failed", output_url=None, error_code="PROVIDER_REJECTED")
    ]
    result = await tools.generate_anchor_sheet(ctx, ["全身正面平视的女性", "空景全景平视的门厅"])

    request = generations.submitted[0]
    assert request.reference_image_urls == ()
    assert (request.aspect_ratio, request.resolution) == (ANCHOR_ASPECT, GRID_RESOLUTION)
    assert request.prompt.count("visual_prompt:") == 4
    assert "全局参考设定" not in request.prompt
    assert request.prompt.startswith("1. Core Command")
    assert isinstance(result, dict)
    assert result["images"] == []


FRAME_URL = "https://cdn.test/frames/s1-1.jpg"
OTHER_FRAME_URL = "https://cdn.test/frames/s2-1.jpg"


def one_shot(**overrides: Any) -> VideoShotRequest:
    fields: dict[str, Any] = {
        "index": 1,
        "prompt": "0-8s 全景 平视 固定，她走进门厅 @Image1。不要字幕，不要背景音乐。",
        "seconds": 8,
        "image_urls": [FRAME_URL],
    }
    return VideoShotRequest(**{**fields, **overrides})


async def deliver(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    shots: list[VideoShotRequest],
    *,
    aspect_ratio: str = "9:16",
) -> dict[str, Any]:
    """直接调用交付工具体，取给模型的那份；地址范围校验由独立用例覆盖。"""

    _ = files
    delivered = await tools.write_video_shots(ctx, aspect_ratio, shots)
    assert isinstance(delivered.return_value, dict)
    return delivered.return_value


async def test_delivered_table_lands_in_the_workspace(
    tools: ShotVideoToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> None:

    result = await deliver(
        tools,
        ctx,
        files,
        [one_shot(), one_shot(index=2, seconds=12, image_urls=[FRAME_URL, OTHER_FRAME_URL])],
    )

    assert result["path"] == SHOTS_PATH
    assert "20 秒" in result["message"]
    stored = await files.read(NAMESPACE, SHOTS_PATH)
    assert stored is not None
    document = json.loads(stored.content)
    assert document["aspectRatio"] == "9:16"
    assert [row["index"] for row in document["shots"]] == [1, 2]
    assert document["shots"][1]["imageUrls"] == [FRAME_URL, OTHER_FRAME_URL]


@pytest.mark.parametrize(
    ("shots", "message"),
    [
        ([], "一条都没有"),
        ([one_shot(index=2)], "连续编号"),
        ([one_shot(prompt="   ")], "prompt 为空"),
        ([one_shot(seconds=3)], "4-30"),
        ([one_shot(seconds=31)], "4-30"),
        ([one_shot(image_urls=[])], "image_urls 为空"),
        (
            [one_shot(prompt="0-8s 她走进门厅 @Image2。")],
            "@Image2",
        ),
    ],
)
async def test_delivery_rejects_the_whole_table(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    shots: list[VideoShotRequest],
    message: str,
) -> None:

    with pytest.raises(ModelRetry, match=message):
        await deliver(tools, ctx, files, shots)
    assert await files.read(NAMESPACE, SHOTS_PATH) is None


async def test_delivery_rejects_a_bad_aspect_ratio(
    tools: ShotVideoToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> None:
    with pytest.raises(ModelRetry, match="画幅"):
        await deliver(tools, ctx, files, [one_shot()], aspect_ratio="竖版")
    assert await files.read(NAMESPACE, SHOTS_PATH) is None


async def test_delivery_accepts_a_frame_url_the_tools_wrote_down(
    tools: ShotVideoToolset[object], ctx: RunContext[object], materials: FakeMaterialLedger
) -> None:

    materials.rows[(NAMESPACE, FRAME_URL)] = Material(url=FRAME_URL, kind="image")
    await check_args(tools, "write_video_shots", ctx, aspect_ratio="9:16", shots=[one_shot()])


async def test_delivery_rejects_a_made_up_frame_url(
    tools: ShotVideoToolset[object], ctx: RunContext[object]
) -> None:
    """拒绝未登记帧地址，错误仅提示合法来源，不回显该地址。"""

    with pytest.raises(ModelRetry, match="frames/grids/") as rejected:
        await check_args(
            tools,
            "write_video_shots",
            ctx,
            aspect_ratio="9:16",
            shots=[one_shot(image_urls=["https://cdn.test/编的.jpg"])],
        )
    assert "编的" not in str(rejected.value), "被拒的地址不回显，否则重试一次就洗成素材了"


async def test_delivery_rejects_a_frame_url_that_is_not_http(
    tools: ShotVideoToolset[object], ctx: RunContext[object]
) -> None:
    with pytest.raises(ModelRetry, match="http"):
        await check_args(
            tools,
            "write_video_shots",
            ctx,
            aspect_ratio="9:16",
            shots=[one_shot(image_urls=["frames/s1-1.jpg"])],
        )


def shots_document(**overrides: Any) -> str:
    """与工具交付格式一致的有效镜头组 prompt 表。"""

    row: dict[str, Any] = {
        "index": 1,
        "prompt": "0-8s 全景 平视 固定，她走进门厅 @Image1。不要字幕，不要背景音乐。",
        "seconds": 8,
        "imageUrls": [FRAME_URL],
    }
    document: dict[str, Any] = {"aspectRatio": "9:16", "shots": [row]}
    return json.dumps({**document, **overrides}, ensure_ascii=False)


def test_written_back_table_passes_the_same_shape_check_as_delivery() -> None:

    validate_video_shots_document(shots_document())


def test_written_back_table_does_not_ask_where_the_urls_came_from() -> None:
    """素材来源校验约束模型生成；用户写回仅校验文档形状。"""

    validate_video_shots_document(
        shots_document(
            shots=[
                json.loads(shots_document())["shots"][0]
                | {"imageUrls": ["https://别处.test/x.jpg"]}
            ]
        )
    )


@pytest.mark.parametrize(
    ("content", "message"),
    [
        ("{不是 json", "不是合法的 JSON"),
        ("[]", "根必须是一个对象"),
        (json.dumps({"aspectRatio": "9:16"}), "shots 要写成一个数组"),
        (shots_document(aspectRatio="竖版"), "画幅"),
        (json.dumps({"aspectRatio": "9:16", "shots": [{"index": 1}]}), "第 1 个镜头组"),
        (
            shots_document(shots=[json.loads(shots_document())["shots"][0] | {"index": 2}]),
            "连续编号",
        ),
        (
            shots_document(shots=[json.loads(shots_document())["shots"][0] | {"seconds": 31}]),
            "4-30",
        ),
        (
            shots_document(shots=[json.loads(shots_document())["shots"][0] | {"imageUrls": []}]),
            "image_urls 为空",
        ),
        (
            shots_document(
                shots=[json.loads(shots_document())["shots"][0] | {"imageUrls": ["  "]}]
            ),
            "空地址",
        ),
        (
            shots_document(
                shots=[
                    json.loads(shots_document())["shots"][0]
                    | {"prompt": "0-8s 她走进门厅 @Image2。"}
                ]
            ),
            "@Image2",
        ),
    ],
    ids=[
        "bad-json",
        "not-object",
        "no-shots",
        "bad-aspect",
        "bad-row",
        "index-gap",
        "seconds",
        "no-urls",
        "blank-url",
        "image-ref",
    ],
)
def test_written_back_table_is_rejected_with_the_reason(content: str, message: str) -> None:

    with pytest.raises(ValueError, match=message):
        validate_video_shots_document(content)
