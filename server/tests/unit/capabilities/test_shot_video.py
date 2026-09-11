"""使用内存替身验证取帧与出图工具、生成重试与能力装配；ffmpeg 执行由集成测试覆盖。"""

from __future__ import annotations

import inspect
import json
import uuid
from dataclasses import replace
from typing import Any

import pytest
from pydantic_ai import Agent, ModelRetry, ToolFailed
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
from structlog.testing import capture_logs

from iclip.capabilities.shot_video.capability import (
    CAPABILITY_ID,
    GenerationPolicy,
    ShotVideo,
    shot_video_capability,
)
from iclip.capabilities.shot_video.delivery import FrameRequest
from iclip.capabilities.shot_video.extraction import EXTRACTION_PATH
from iclip.capabilities.shot_video.generation import (
    ANCHOR_ASPECT,
    GRID_RESOLUTION,
    IMAGE_MODEL,
)
from iclip.capabilities.shot_video.toolset import ShotVideoToolset
from iclip.capabilities.video.capability import Video
from iclip.capabilities.video_understanding import video_doc_path
from iclip.capabilities.workspace.scope import workspace_namespace
from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.generation.module import IMAGE_MODEL_SPECS
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
        user_name="luke",
    )


def make_context(deps: object) -> RunContext[object]:

    return RunContext[object](deps=deps, model=TestModel(), usage=RunUsage(), messages=[])


def ledger(*_cell_ids: str) -> str:
    """取帧账本。逐格请求不校验帧号是否在账本里，出图工具只看它存不存在。"""

    return json.dumps(
        {
            "extractionVersion": 1,
            "extractionKey": "k",
            "boards": [{"board": 1, "url": "https://cdn.test/board.jpg"}],
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
) -> ShotVideo[object]:
    return shot_video_capability(
        space=FileSpace(store=files, namespace=workspace_namespace),
        ledger=materials,
        generations=generations,
        objects=objects,
        paths=MEDIA_PATHS,
        client=None,  # type: ignore[arg-type]  # 本测试不调用素材下载。
        image_models=frozenset({IMAGE_MODEL}),
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
    assert seen == ["generate_anchor_sheet", "generate_shot_frames", "plan_shot_frames"]


@pytest.mark.parametrize("tool_name", ["plan_shot_frames", "generate_shot_frames"])
def test_scope_rules_are_mounted_on_the_tool(
    tools: ShotVideoToolset[object], tool_name: str
) -> None:
    """校验器单测无法发现挂载遗漏，需检查工具注册表的 args_validator。"""

    assert tools.tools[tool_name].args_validator is not None


def test_every_tool_has_a_display(capability: ShotVideo[object]) -> None:

    drawn = ToolDisplayRegistry.merged(capability.display_table()).entries
    assert sorted(drawn) == ["generate_anchor_sheet", "generate_shot_frames", "plan_shot_frames"]
    # 标题是书面动宾短语，主语是镜头号；张数进结果角标，不进标题。
    assert drawn["generate_shot_frames"].draw(
        {"frames": [{"no": "S2-1"}, {"no": "S1-3"}, {"no": "S2-2"}]}
    ) == GenericDisplay(summary="生成画面", detail="镜头 1、2")
    assert drawn["generate_shot_frames"].draw(None) == GenericDisplay(summary="生成画面")
    assert drawn["plan_shot_frames"].draw({"video_url": VIDEO}) == GenericDisplay(
        summary="提取候选帧", detail="ref.mp4"
    )
    assert drawn["generate_anchor_sheet"].draw({}) == GenericDisplay(summary="生成设定图")


def test_every_media_tool_picks_a_renderer(capability: ShotVideo[object]) -> None:

    views = ToolDisplayRegistry.merged(capability.display_table())
    for tool_name in ("plan_shot_frames", "generate_shot_frames", "generate_anchor_sheet"):
        assert views.view_of(tool_name) == "media_grid"


async def test_an_out_of_scope_address_is_refused_on_the_agent_path(
    capability: ShotVideo[object], files: FakeFileStore
) -> None:
    """通过真实 Agent 确认未登记地址在工具执行前被拒绝。"""

    def call_once(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        if len(messages) == 1:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        "plan_shot_frames",
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
    assert await files.entries(NAMESPACE) == []


async def test_missing_run_identity_is_a_bug_not_a_retry(tools: ShotVideoToolset[object]) -> None:
    """deps 类型错误属于装配故障，模型重试无法修复。"""

    with pytest.raises(RuntimeError, match="AgentRunDeps"):
        await tools.plan_shot_frames(make_context(object()), VIDEO)


async def test_parse_and_plan_agree_on_where_the_document_lives(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    materials: FakeMaterialLedger,
) -> None:
    """取帧工具按同一路径读到 video 能力写下的拆解文档；用无时间码文档触发解析错误来确认。"""

    video = Video[object](
        space=FileSpace(store=files, namespace=workspace_namespace),
        ledger=materials,
        understanding=FakeUnderstanding(document="## 4、逐镜拉片表\n没有任何时间码\n"),
    )
    await video.get_toolset().video_parser(ctx, VIDEO)
    with pytest.raises(ModelRetry, match="解析失败"):
        await tools.plan_shot_frames(ctx, VIDEO)


@pytest.mark.parametrize("url", ["ref.mp4", "file:///etc/passwd", "ftp://host/a.mp4"])
async def test_tools_only_take_http_urls(
    tools: ShotVideoToolset[object], ctx: RunContext[object], url: str
) -> None:
    with pytest.raises(ModelRetry, match="http"):
        await check_args(tools, "plan_shot_frames", ctx, video_url=url)


async def test_plan_refuses_an_address_the_conversation_never_had(
    tools: ShotVideoToolset[object], ctx: RunContext[object]
) -> None:
    """素材范围校验必须先于视频下载，避免请求未登记的地址。"""

    with pytest.raises(ModelRetry, match="不是这段对话里的素材") as failure:
        await check_args(tools, "plan_shot_frames", ctx, video_url="https://cdn.test/made-up.mp4")

    # 不回显未登记地址，避免重试消息将其引入素材上下文。
    assert "made-up" not in str(failure.value)


async def test_plan_refuses_an_image_the_user_sent(
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


async def test_plan_needs_the_document_first(
    tools: ShotVideoToolset[object], ctx: RunContext[object]
) -> None:
    """替身不提供 HTTP 客户端；缺少文档时应在下载前失败。"""

    with pytest.raises(ModelRetry, match="video_parser"):
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
    with pytest.raises(ToolFailed):
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
    with pytest.raises(ToolFailed):
        await tools.generate_shot_frames(
            ctx, [FrameRequest(no="S1-1", prompt="猫")], [], "全局", "9:16"
        )
    with pytest.raises(ToolFailed):
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
    with pytest.raises(ToolFailed):
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
) -> ToolFailed:
    """提交一次生成并捕获模型可见的失败，避免依赖 ffmpeg 切格。"""

    await files.write(NAMESPACE, EXTRACTION_PATH, ledger("S1-1"))
    with pytest.raises(ToolFailed) as failed:
        await tools.generate_shot_frames(
            ctx, [FrameRequest(no="S1-1", prompt="猫")], [], "全局参考", "9:16"
        )
    return failed.value


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
    assert result.message == "镜头帧生成失败（PROVIDER_UNREACHABLE）。"


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
    assert result.message == f"镜头帧生成失败（{error_code}）。"


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
        client=None,  # type: ignore[arg-type]
        image_models=frozenset({IMAGE_MODEL}),
        policy=GenerationPolicy(
            poll_interval_seconds=0.001, dev_attempts=2, pro_attempts=0, backoff_seconds=0.001
        ),
    ).get_toolset()
    assert isinstance(toolset, ShotVideoToolset)
    result = await submit_once(toolset, ctx, files)
    assert generations.channels() == ["dev", "dev"]
    assert result.message == "镜头帧生成失败（PROVIDER_REJECTED）。"


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


async def test_generate_timeout_is_a_brief_failure_and_logs_the_record(
    ctx: RunContext[object],
    generations: FakeGenerations,
    objects: FakeObjects,
    files: FakeFileStore,
) -> None:
    """超时对模型报告失败，诊断留日志；总时限耗尽后不新增生成。"""

    generations.outcomes = [Outcome(status="submitted", output_url=None)]
    toolset = shot_video_capability(
        space=FileSpace(store=files, namespace=workspace_namespace),
        ledger=FakeMaterialLedger(),
        generations=generations,
        objects=objects,
        paths=MEDIA_PATHS,
        client=None,  # type: ignore[arg-type]
        image_models=frozenset({IMAGE_MODEL}),
        policy=GenerationPolicy(
            poll_interval_seconds=0.001,
            dev_attempts=1,
            pro_attempts=1,
            backoff_seconds=0.001,
            total_timeout_seconds=0.02,
        ),
    ).get_toolset()
    assert isinstance(toolset, ShotVideoToolset)
    with capture_logs() as logs:
        result = await submit_once(toolset, ctx, files)
    assert generations.channels() == ["dev"]
    assert result.message == "镜头帧生成失败（TOOL_WAIT_TIMEOUT）。"
    assert logs[-1]["error_code"] == "TOOL_WAIT_TIMEOUT"
    assert logs[-1]["job_id"] == str(generations.job_ids[0])


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
    with pytest.raises(ToolFailed, match=r"^设定图生成失败（PROVIDER_REJECTED）。$"):
        await tools.generate_anchor_sheet(ctx, ["全身正面平视的女性", "空景全景平视的门厅"])

    request = generations.submitted[0]
    assert request.reference_image_urls == ()
    assert (request.aspect_ratio, request.resolution) == (ANCHOR_ASPECT, GRID_RESOLUTION)
    assert request.prompt.count("visual_prompt:") == 4
    assert "全局参考设定" not in request.prompt
    assert request.prompt.startswith("1. Core Command")


async def test_stringified_frames_are_parsed_on_the_agent_path(
    capability: ShotVideo[object],
    files: FakeFileStore,
    generations: FakeGenerations,
) -> None:
    """frames 与 shots 同形；模型把它裹成字符串时照常受理，不退回改参数。"""

    await files.write(NAMESPACE, EXTRACTION_PATH, ledger("S1-1"))
    generations.outcomes = [
        Outcome(status="failed", output_url=None, error_code="PROVIDER_REJECTED")
    ]
    args = {
        "frames": json.dumps([{"no": "S1-1", "prompt": "猫"}], ensure_ascii=False),
        "reference_images": [],
        "global_reference": "全局参考",
        "target_aspect": "9:16",
    }

    def call_once(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        if len(messages) == 1:
            return ModelResponse(
                parts=[ToolCallPart("generate_shot_frames", args, tool_call_id="c1")]
            )
        return ModelResponse(parts=[TextPart("好")])

    with capture_logs() as logs:
        result = await Agent(FunctionModel(call_once), capabilities=[capability]).run(
            "出这一批帧", deps=make_deps()
        )

    refusals = [
        part
        for message in result.all_messages()
        for part in message.parts
        if isinstance(part, RetryPromptPart) and part.tool_name == "generate_shot_frames"
    ]
    assert refusals == []
    parsed = [log for log in logs if log["event"] == "工具参数以字符串传入，已解析"]
    assert [log["field"] for log in parsed] == ["frames"]


def test_the_pinned_image_model_can_do_what_the_frame_tools_ask_for() -> None:
    """出图把用哪家、多大、哪个渠道都钉在代码里，模型面签名里没有这些参数。

    钉的那家给不了其中任何一样，就是每次出图都拿到一个模型改不了的错误。这些全是代码
    里的常量，所以在这里拦，不等部署。"""

    spec = IMAGE_MODEL_SPECS.get(IMAGE_MODEL)
    assert spec is not None, f"{IMAGE_MODEL} 没有对应的适配器"
    assert GRID_RESOLUTION in spec.resolutions
    assert ANCHOR_ASPECT in spec.aspect_ratios
    assert set(GenerationPolicy().channels()) <= set(spec.channels)
