"""镜头素材能力：工具面的语义、出图的重试与升级、装配面接得上。

出图、对象存储、视频拆解、文件存储都用进程内替身，所以这一层测的是「工具怎么决
策」。碰 ffmpeg 的那两件在这里只验它们动手之前就把前置条件拦下了——真跑一遍在集
成层。
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from pydantic_ai import Agent, ModelRetry
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import RunContext
from pydantic_ai.usage import RunUsage

from iclip.capabilities.shot_video.capability import (
    ANCHOR_ASPECT,
    CAPABILITY_ID,
    EXTRACTION_PATH,
    GRID_RESOLUTION,
    SHOTS_PATH,
    FrameRequest,
    GenerationPolicy,
    ShotVideo,
    ShotVideoToolset,
    VideoShotRequest,
    shot_video_capability,
    video_doc_path,
)
from iclip.capabilities.shot_video.parser import (
    SYSTEM_PROMPT,
    ArkVideoUnderstanding,
    VideoUnderstandingError,
)
from iclip.capabilities.workspace.scope import workspace_namespace
from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.identity.models import Principal
from iclip.harness.media import media_tag
from iclip.platform.file_store.store import FileSpace
from tests.helpers.file_store import FakeFileStore
from tests.helpers.shot_video import (
    FakeGenerations,
    FakeObjects,
    FakeUnderstanding,
    Outcome,
)

USER = uuid.UUID("11111111-1111-1111-1111-111111111111")
VIDEO = "https://cdn.test/ref.mp4"
NAMESPACE = f"{USER}/thread-1"

# 用户把参考片发进来之后，模型上下文里就是这么一行——素材校验认的就是它。
_USER_SENT_VIDEO = f"{media_tag('video', VIDEO, name='ref.mp4')} 帮我拆一下"

# 一份最小的拆解文档：一个结构层级一行，行内两个镜头。
DOCUMENT = (
    "## 4、逐镜拉片表\n"
    "| 结构层级 | Storyline |\n"
    "| Rain-Step Hook | **[00:00.000-00:02.000]** 中景……<br><br>"
    "**[00:02.000-00:04.000]** 特写…… |\n"
)

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


def make_context(deps: object, *, said: str = _USER_SENT_VIDEO) -> RunContext[object]:
    """造一次运行的上下文，默认当作用户已经把参考片发进来了。

    素材校验要在消息里逐字找得到地址（见 `harness/materials.py`），所以不给消息的
    话，每件工具都会先被素材校验拦下——那不是这些用例想测的东西。
    """

    return RunContext[object](
        deps=deps,
        model=TestModel(),
        usage=RunUsage(),
        messages=[ModelRequest(parts=[UserPromptPart(content=said)])],
    )


def ledger(*cell_ids: str) -> str:
    """一份取帧账本，只放逐格请求校验用得到的那部分。"""

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
def capability(
    files: FakeFileStore,
    generations: FakeGenerations,
    objects: FakeObjects,
    understanding: FakeUnderstanding,
) -> ShotVideo[object]:
    return shot_video_capability(
        space=FileSpace(store=files, namespace=workspace_namespace),
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
    """依赖都是运行期对象，YAML 里造不出来——所以不对外宣称能反序列化。"""

    assert ShotVideo.get_serialization_name() is None


def test_no_capability_instructions(capability: ShotVideo[object]) -> None:
    """不注入指令：这几件工具怎么接力是流程知识，归 skill，不归能力包。"""

    assert capability.get_instructions() is None


async def test_every_tool_reaches_the_model(capability: ShotVideo[object]) -> None:
    """挂到真 Agent 上：六件工具都出现在模型看得到的工具表里。"""

    seen: list[str] = []

    def script(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        _ = messages
        seen.extend(sorted(tool.name for tool in info.function_tools))
        return ModelResponse(parts=[TextPart("好")])

    agent = Agent(FunctionModel(script), capabilities=[capability])
    await agent.run("看看你有什么", deps=make_deps())
    assert seen == [
        "ReadMediaFile",
        "generate_anchor_sheet",
        "generate_shot_frames",
        "plan_shot_frames",
        "video_parser_md",
        "write_video_shots",
    ]


async def test_missing_run_identity_is_a_bug_not_a_retry(tools: ShotVideoToolset[object]) -> None:
    """deps 不对是装配出错，不该翻成一句让模型重试的话——它改不动这个。"""

    with pytest.raises(RuntimeError, match="AgentRunDeps"):
        await tools.video_parser_md(make_context(object()), VIDEO)


async def test_files_land_in_the_normalized_namespace(
    objects: FakeObjects, understanding: FakeUnderstanding, files: FakeFileStore
) -> None:
    """本能力写文件的地盘必须经 ``FileSpace.resolve()``，不能拿规则算出来的原样值。

    绕开它不会报错，只是文件落进另一个字符串——工作区那侧照规范化算，于是模型的
    ``read_file`` 看不见这几件工具写的东西。
    """

    toolset = shot_video_capability(
        space=FileSpace(store=files, namespace=lambda _ctx: f"{USER}//thread-1"),
        generations=FakeGenerations(),
        objects=objects,
        understanding=understanding,
        client=None,  # type: ignore[arg-type]  # 这一层不走取素材那条路
        policy=FAST,
    ).get_toolset()
    assert isinstance(toolset, ShotVideoToolset)

    result = await toolset.video_parser_md(make_context(make_deps()), VIDEO)
    assert await files.read(NAMESPACE, result["path"]) is not None


# ── 视频拆解 ──────────────────────────────────────────────────────────────────


async def test_parse_writes_the_document_and_returns_its_path(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    understanding: FakeUnderstanding,
    files: FakeFileStore,
) -> None:
    """正文进工作区，工具只回路径——文档要被后面几步反复读，不该每轮都占上下文。"""

    result = await tools.video_parser_md(ctx, VIDEO)
    assert result["path"] == video_doc_path(VIDEO)
    assert understanding.calls == [VIDEO]
    stored = await files.read(NAMESPACE, result["path"])
    assert stored is not None
    assert stored.content == DOCUMENT


async def test_parse_and_plan_agree_on_where_the_document_lives(
    tools: ShotVideoToolset[object], ctx: RunContext[object], understanding: FakeUnderstanding
) -> None:
    """两件工具各算各的路径。算不到同一份文件上，取帧就永远读不到刚写的那份。

    拆解出一份没有时间码的文档：取帧报的是「解析失败」而不是「文档不存在」，就说
    明它确实读到了上一步写下的那一份。
    """

    understanding.document = "## 4、逐镜拉片表\n没有任何时间码\n"
    await tools.video_parser_md(ctx, VIDEO)
    with pytest.raises(ModelRetry, match="解析失败"):
        await tools.plan_shot_frames(ctx, VIDEO)


def test_document_path_survives_two_videos_of_the_same_name() -> None:
    """两段不同的片子完全可能同名；同名共用一份文档就是互相覆盖。"""

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
        await tools.video_parser_md(ctx, url)


# ── 素材范围 ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("tool_name", ["video_parser_md", "plan_shot_frames"])
async def test_video_tools_refuse_an_address_the_conversation_never_had(
    tools: ShotVideoToolset[object], ctx: RunContext[object], tool_name: str
) -> None:
    """模型编一个地址，就别让服务器去下载它。

    这两件都要把整片拉下来，是三件工具里最贵的一对，所以拦在动手之前。报错里把这
    段对话真有的视频列回去，模型才有得抄。
    """

    call = getattr(tools, tool_name)
    with pytest.raises(ModelRetry, match=VIDEO) as failure:
        await call(ctx, "https://cdn.test/made-up.mp4")

    # 不回显被拒的地址：回显一次，模型重试时它就成了「上下文里出现过」的东西。
    assert "made-up" not in str(failure.value)


async def test_video_tools_refuse_an_image_the_user_sent(
    tools: ShotVideoToolset[object],
) -> None:
    """用户发的是图，拿去当参考片——种类是 tag 明写的，认得出来。"""

    image = "https://cdn.test/poster.jpg"
    ctx = make_context(make_deps(), said=media_tag("image", image, name="poster.jpg"))
    with pytest.raises(ModelRetry, match="图片"):
        await tools.plan_shot_frames(ctx, image)


async def test_reference_images_refuse_a_video(
    tools: ShotVideoToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> None:
    """反过来也拦：参考片的地址当不了参考图。"""

    await files.write(NAMESPACE, EXTRACTION_PATH, ledger("S1-1"))
    with pytest.raises(ModelRetry, match="视频"):
        await tools.generate_shot_frames(
            ctx, [FrameRequest(no="S1-1", prompt="猫")], [VIDEO], "全局", "9:16"
        )


async def test_read_media_file_takes_an_address_from_a_tool_result(
    tools: ShotVideoToolset[object], ctx: RunContext[object]
) -> None:
    """预览板地址只在工具结果的 JSON 里，没有 tag——照样是本对话的素材。"""

    board = "https://bucket.oss-cn-hangzhou.aliyuncs.com/shot-frames/k/board/1.jpg"
    ctx.messages.append(
        ModelRequest(
            parts=[
                ToolReturnPart(
                    tool_name="plan_shot_frames",
                    content={"boards": [{"board": 1, "url": board}]},
                    tool_call_id="1",
                )
            ]
        )
    )

    assert await tools.read_media_file(ctx, board)

    with pytest.raises(ModelRetry, match="不是这段对话里的素材"):
        await tools.read_media_file(
            ctx, "https://bucket.oss-cn-hangzhou.aliyuncs.com/shot-frames/k/board/9.jpg"
        )


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

    把那半份文档交出去，取帧会从一张被截断的镜头表里读时间码，而且没人知道少了
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


# ── 取帧：动手之前就把前置条件拦下 ──────────────────────────────────────────


async def test_plan_needs_the_document_first(
    tools: ShotVideoToolset[object], ctx: RunContext[object]
) -> None:
    """替身里没有 HTTP 客户端，所以能走到这里就证明它没先去取素材。"""

    with pytest.raises(ModelRetry, match="video_parser_md"):
        await tools.plan_shot_frames(ctx, VIDEO)


async def test_plan_points_at_a_repair_the_model_can_perform(
    tools: ShotVideoToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> None:
    """时间码读不出时给的是一条可执行的修法，不是一句「解析失败」。"""

    await files.write(NAMESPACE, video_doc_path(VIDEO), "## 4、逐镜拉片表\n没有任何时间码\n")
    with pytest.raises(ModelRetry) as raised:
        await tools.plan_shot_frames(ctx, VIDEO)
    assert "edit_file" in str(raised.value)


async def test_plan_rejects_a_document_with_a_broken_timecode(
    tools: ShotVideoToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> None:
    """终点不晚于起点就取不出任何一帧，在这里拦住比抽完再发现便宜。"""

    await files.write(NAMESPACE, video_doc_path(VIDEO), "**[00:05.000-00:02.000]** 中景")
    with pytest.raises(ModelRetry, match="终点不晚于起点"):
        await tools.plan_shot_frames(ctx, VIDEO)


# ── 按批出帧：账本与逐格请求的校验 ──────────────────────────────────────────


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
        ([FrameRequest(no="S9-9", prompt="猫")], "不在取帧账本"),
        ([FrameRequest(no="S1-1", prompt="猫"), FrameRequest(no="S1-1", prompt="狗")], "重复"),
        ([FrameRequest(no="S1-1", prompt="  ")], "为空"),
    ],
    ids=["empty", "too-many", "bad-shape", "unknown", "duplicate", "blank-prompt"],
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


async def test_generate_reference_urls_must_be_http(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    generations: FakeGenerations,
) -> None:
    await files.write(NAMESPACE, EXTRACTION_PATH, ledger("S1-1"))
    with pytest.raises(ModelRetry, match="参考图"):
        await tools.generate_shot_frames(
            ctx, [FrameRequest(no="S1-1", prompt="猫")], ["grid.png"], "全局", "9:16"
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


# ── 出图：重试与升级 ─────────────────────────────────────────────────────────


async def submit_once(
    tools: ShotVideoToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> dict[str, Any]:
    """走一次出图。收敛后的切格要 ffmpeg，所以这里用的都是失败结局。"""

    await files.write(NAMESPACE, EXTRACTION_PATH, ledger("S1-1"))
    return await tools.generate_shot_frames(
        ctx, [FrameRequest(no="S1-1", prompt="猫")], [], "全局参考", "9:16"
    )


async def test_generate_submits_a_full_grid_at_the_top_tier(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    generations: FakeGenerations,
) -> None:
    """一格也按四格提交：切完每格只剩四分之一分辨率，档位低了不够交付。"""

    generations.outcomes = [
        Outcome(status="failed", output_url=None, error_code="PROVIDER_REJECTED")
    ]
    await submit_once(tools, ctx, files)
    request = generations.submitted[0]
    assert request.resolution == GRID_RESOLUTION
    assert request.aspect_ratio == "9:16"
    assert "全局参考" in request.prompt
    # 空格由中性面板补满，凑够一张 2×2。
    assert request.prompt.count("visual_prompt:") == 4


async def test_generate_retries_only_what_never_arrived(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    generations: FakeGenerations,
) -> None:
    """连不上是确定没计费的失败，重发一次是安全的。"""

    generations.outcomes = [
        Outcome(status="failed", output_url=None, error_code="PROVIDER_UNREACHABLE"),
        Outcome(status="failed", output_url=None, error_code="PROVIDER_REJECTED"),
    ]
    result = await submit_once(tools, ctx, files)
    assert generations.channels() == ["dev", "dev"]
    assert "PROVIDER_REJECTED" in result["error"]


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
        "PROVIDER_RESULT_UNKNOWN",
        "PROVIDER_REJECTED",
        "PROVIDER_MALFORMED",
        "OUTPUT_STORE_FAILED",
        "OUTPUT_DOWNLOAD_FAILED",
        "SUBMIT_INTERRUPTED",
        "PROVIDER_TIMEOUT",
    ],
)
async def test_generate_stops_where_money_may_already_be_spent(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    generations: FakeGenerations,
    error_code: str,
) -> None:
    """这些失败都可能已经计费（或再发一次也是同样答复），一次都不许自动重发。"""

    generations.outcomes = [Outcome(status="failed", output_url=None, error_code=error_code)]
    result = await submit_once(tools, ctx, files)
    assert generations.channels() == ["dev"]
    assert error_code in result["error"]


async def test_generate_rejects_bad_parameters_before_paying(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    generations: FakeGenerations,
) -> None:
    """参数不合规是在提交之前拒的，一分钱没花，所以让模型改了重来。"""

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
    """等超时不等于这次生成没了：把记录 id 报回去，人还能自己去查。"""

    generations.outcomes = [Outcome(status="submitted", output_url=None)]
    toolset = shot_video_capability(
        space=FileSpace(store=files, namespace=workspace_namespace),
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
    result = await submit_once(toolset, ctx, files)
    assert "TOOL_WAIT_TIMEOUT" in result["error"]
    assert str(generations.job_ids[0]) in result["error"]


# ── 补拍设定图 ────────────────────────────────────────────────────────────────


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
    """条数越界、描述为空都在提交之前拒——拒晚了这一版已经计过费。"""

    with pytest.raises(ModelRetry, match=message):
        await tools.generate_anchor_sheet(ctx, cells)
    assert generations.submitted == []


async def test_anchor_sheet_submits_a_full_square_grid_without_references(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    generations: FakeGenerations,
) -> None:
    """补拍是纯文生图：不带参考图，按方版最高档出，空格补满。"""

    generations.outcomes = [
        Outcome(status="failed", output_url=None, error_code="PROVIDER_REJECTED")
    ]
    result = await tools.generate_anchor_sheet(ctx, ["全身正面平视的女性", "空景全景平视的门厅"])

    request = generations.submitted[0]
    assert request.reference_image_urls == ()
    assert (request.aspect_ratio, request.resolution) == (ANCHOR_ASPECT, GRID_RESOLUTION)
    # 空格由中性面板补满，凑够一张 2×2。
    assert request.prompt.count("visual_prompt:") == 4
    # 正文与镜头帧那版同一段，少的只有「全局参考设定」——补拍没有参考图可写。
    assert "全局参考设定" not in request.prompt
    assert request.prompt.startswith("1. Core Command")
    # 失败时给的是空的 images，不是空的 frames——调用方按这件工具的产物名去取。
    assert result["images"] == []


# ── 交付镜头组 prompt 表 ──────────────────────────────────────────────────────

FRAME_URL = "https://cdn.test/frames/s1-1.jpg"
OTHER_FRAME_URL = "https://cdn.test/frames/s2-1.jpg"


def grid_record(*urls: str) -> str:
    """一份出帧版记录，只放交付校验用得到的那部分。"""

    return json.dumps(
        {
            "gridRecordVersion": 1,
            "jobId": "job-1",
            "frames": [{"no": f"S{index}-1", "url": url} for index, url in enumerate(urls, 1)],
        }
    )


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
    """把一份已生成的帧记录铺好，再走一次交付。"""

    await files.write(NAMESPACE, "frames/grids/job-1.json", grid_record(FRAME_URL, OTHER_FRAME_URL))
    return await tools.write_video_shots(ctx, aspect_ratio, shots)


async def test_delivered_table_lands_in_the_workspace(
    tools: ShotVideoToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> None:
    """交付即落文件：模型的 `read_file` 与下一轮的定位都只认这份文件。"""

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
        ([one_shot(image_urls=["https://cdn.test/编的.jpg"])], "不是 generate_shot_frames"),
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
    """有一条不合规就整份拒收，不留下半份产物。"""

    with pytest.raises(ModelRetry, match=message):
        await deliver(tools, ctx, files, shots)
    assert await files.read(NAMESPACE, SHOTS_PATH) is None


async def test_delivery_rejects_a_bad_aspect_ratio(
    tools: ShotVideoToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> None:
    with pytest.raises(ModelRetry, match="画幅"):
        await deliver(tools, ctx, files, [one_shot()], aspect_ratio="竖版")
    assert await files.read(NAMESPACE, SHOTS_PATH) is None


async def test_delivery_without_any_generated_frame_points_at_the_records(
    tools: ShotVideoToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> None:
    """一帧都还没生成时，报的是「去哪儿找地址」而不是「地址不对」。"""

    with pytest.raises(ModelRetry, match="frames/grids/"):
        await tools.write_video_shots(ctx, "9:16", [one_shot()])
