"""通过真实 Agent 与工具体验证视频拆解、素材范围与镜头组交付。"""

from __future__ import annotations

import inspect
import json
import uuid
from typing import Any

import pytest
from pydantic_ai import Agent, ModelRetry
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import RunContext
from pydantic_ai.usage import RunUsage
from structlog.testing import capture_logs
from structlog.typing import EventDict

from iclip.capabilities.shot_document import (
    MAX_REFERENCE_IMAGES,
    SHOTS_PATH,
    VideoShotRequest,
    validate_shots_document,
)
from iclip.capabilities.video.capability import CAPABILITY_ID, Video, VideoToolset
from iclip.capabilities.video_document import video_doc_path
from iclip.capabilities.video_understanding import VideoUnderstandingError
from iclip.capabilities.workspace.scope import workspace_namespace
from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.identity.models import Principal
from iclip.platform.file_store.store import FileSpace
from iclip.platform.material_ledger.store import Material
from iclip.platform.transcript.display import GenericDisplay, ToolDisplayRegistry
from tests.helpers.file_store import FakeFileStore
from tests.helpers.material_ledger import FakeMaterialLedger
from tests.helpers.shot_document import FRAME_URL, OTHER_FRAME_URL, one_shot, shots_document
from tests.helpers.shot_video import FakeUnderstanding

USER = uuid.UUID("11111111-1111-1111-1111-111111111111")
VIDEO = "https://cdn.test/ref.mp4"
NAMESPACE = f"{USER}/thread-1"
OTHER_NAMESPACE = f"{USER}/thread-2"
DOCUMENT = "## 逐镜拉片表\n**[00:00.000-00:30.000]** 产品演示。"


@pytest.fixture
def files() -> FakeFileStore:
    return FakeFileStore()


@pytest.fixture
def materials() -> FakeMaterialLedger:
    """参考视频与一张镜头帧已在收件阶段登记。"""

    ledger = FakeMaterialLedger()
    ledger.rows[(NAMESPACE, VIDEO)] = Material(url=VIDEO, kind="video")
    ledger.rows[(NAMESPACE, FRAME_URL)] = Material(url=FRAME_URL, kind="image")
    return ledger


@pytest.fixture
def understanding() -> FakeUnderstanding:
    return FakeUnderstanding(document=DOCUMENT)


@pytest.fixture
def capability(
    files: FakeFileStore, materials: FakeMaterialLedger, understanding: FakeUnderstanding
) -> Video[object]:
    return Video[object](
        space=FileSpace(store=files, namespace=workspace_namespace),
        ledger=materials,
        understanding=understanding,
    )


@pytest.fixture
def tools(capability: Video[object]) -> VideoToolset[object]:
    return capability.get_toolset()


@pytest.fixture
def ctx() -> RunContext[object]:
    return make_context(make_deps())


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


def shot_payload(image_urls: list[str]) -> dict[str, Any]:
    """agent 路径提交的一组镜头；全局设定按顺序引用每张图。"""

    references = "、".join(f"@Image{index}" for index in range(1, len(image_urls) + 1))
    return {
        "aspect_ratio": "9:16",
        "shots": [
            {
                "index": 1,
                "prompt": {
                    "global_settings": f"产品外观使用参考图片 {references}。",
                    "timeline": [
                        {"timestamps": [0, 15], "prompt": "中景，人物拿起产品。"},
                        {"timestamps": [15, 30], "prompt": "特写，展示产品细节。"},
                    ],
                },
                "seconds": 30,
                "image_urls": image_urls,
            }
        ],
    }


async def invoke(
    capability: Video[object], tool_name: str, args: str | dict[str, Any]
) -> list[ModelMessage]:
    """模型只调用一次工具，随后结束，保留注册校验器与工具返回的完整路径。"""

    def script(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        if len(messages) == 1:
            return ModelResponse(parts=[ToolCallPart(tool_name, args, tool_call_id="video-call")])
        return ModelResponse(parts=[TextPart("本轮结束。")])

    result = await Agent(FunctionModel(script), capabilities=[capability]).run(
        "处理参考素材。", deps=make_deps()
    )
    return result.all_messages()


def refusals(messages: list[ModelMessage]) -> list[RetryPromptPart]:
    return [
        part for message in messages for part in message.parts if isinstance(part, RetryPromptPart)
    ]


def returns(messages: list[ModelMessage]) -> list[ToolReturnPart]:
    return [
        part for message in messages for part in message.parts if isinstance(part, ToolReturnPart)
    ]


async def check_args(
    tools: VideoToolset[object], name: str, ctx: RunContext[object], **args: Any
) -> None:
    """通过工具注册表调用校验器，覆盖 args_validator 的挂载遗漏。"""

    validator = tools.tools[name].args_validator
    assert validator is not None, f"{name} 登记时没挂验证器"
    outcome = validator(ctx, **args)
    assert inspect.isawaitable(outcome), "本包的验证器都是 async 的"
    await outcome


async def deliver(
    tools: VideoToolset[object],
    ctx: RunContext[object],
    shots: list[VideoShotRequest],
    *,
    aspect_ratio: str = "9:16",
) -> str:
    """直接调用交付工具体，取给模型的那份；地址范围校验由独立用例覆盖。"""

    delivered = await tools.write_video_shots(ctx, aspect_ratio, shots)
    assert isinstance(delivered.return_value, str)
    return delivered.return_value


def test_capability_id_is_fixed(capability: Video[object]) -> None:
    assert capability.id == CAPABILITY_ID
    assert capability.get_toolset().id == CAPABILITY_ID


def test_not_constructible_from_spec() -> None:
    assert Video.get_serialization_name() is None


async def test_only_video_tools_reach_the_model(capability: Video[object]) -> None:
    seen: list[str] = []

    def script(_messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        seen.extend(sorted(tool.name for tool in info.function_tools))
        return ModelResponse(parts=[TextPart("好")])

    await Agent(FunctionModel(script), capabilities=[capability]).run(
        "查看工具。", deps=make_deps()
    )

    assert seen == ["video_parser", "write_video_shots"]
    assert set(capability.display_table()) == set(seen)


async def test_structured_shot_input_schema_reaches_the_model(capability: Video[object]) -> None:
    seen: dict[str, Any] = {}

    def script(_messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        tool = next(tool for tool in info.function_tools if tool.name == "write_video_shots")
        seen["schema"] = tool.parameters_json_schema
        seen["description"] = tool.description
        return ModelResponse(parts=[TextPart("好")])

    await Agent(FunctionModel(script), capabilities=[capability]).run("看看参数", deps=make_deps())

    schema = seen["schema"]
    assert set(schema["properties"]) == {"aspect_ratio", "shots"}
    assert set(schema["required"]) == {"aspect_ratio", "shots"}
    definitions = schema["$defs"]
    shot = definitions["VideoShotRequest"]
    assert set(shot["properties"]) == {"index", "prompt", "seconds", "image_urls"}
    assert set(shot["required"]) == set(shot["properties"])
    assert shot["properties"]["prompt"] == {"$ref": "#/$defs/VideoShotPrompt"}
    assert shot["properties"]["image_urls"]["type"] == "array"
    assert shot["properties"]["image_urls"].get("minItems", 0) == 0
    assert shot["properties"]["image_urls"]["maxItems"] == MAX_REFERENCE_IMAGES
    prompt = definitions["VideoShotPrompt"]
    assert prompt["type"] == "object"
    assert set(prompt["properties"]) == {"global_settings", "timeline"}
    assert set(prompt["required"]) == set(prompt["properties"])
    assert prompt["additionalProperties"] is False
    assert prompt["properties"]["timeline"]["minItems"] == 1
    timeline_item = definitions["TimelineItem"]
    assert set(timeline_item["properties"]) == {"timestamps", "prompt"}
    assert set(timeline_item["required"]) == set(timeline_item["properties"])
    assert timeline_item["additionalProperties"] is False
    timestamps = timeline_item["properties"]["timestamps"]
    assert timestamps["type"] == "array"
    assert timestamps["minItems"] == timestamps["maxItems"] == 2
    assert timestamps["items"]["type"] == "number"
    assert timestamps["items"]["minimum"] == 0
    assert (
        seen["description"].splitlines()[0]
        == "提交镜头组 prompt 表；每次提交全部镜头组，替换已有的。"
    )


@pytest.mark.parametrize("tool_name", ["video_parser", "write_video_shots"])
def test_scope_rules_are_mounted_on_the_tool(tools: VideoToolset[object], tool_name: str) -> None:
    """校验器单测无法发现挂载遗漏，需检查工具注册表的 args_validator。"""

    assert tools.tools[tool_name].args_validator is not None


def test_every_tool_has_a_display_without_a_renderer(capability: Video[object]) -> None:
    registry = ToolDisplayRegistry.merged(capability.display_table())
    drawn = registry.entries
    assert sorted(drawn) == ["video_parser", "write_video_shots"]
    assert drawn["write_video_shots"].draw({}) == GenericDisplay(
        summary="保存分镜", detail=SHOTS_PATH
    )
    assert drawn["video_parser"].draw({"video_url": VIDEO}) == GenericDisplay(
        summary="拆解视频", detail="ref.mp4"
    )
    assert drawn["video_parser"].draw({}) == GenericDisplay(summary="拆解视频")
    for tool_name in drawn:
        assert registry.view_of(tool_name) is None


async def test_parse_stores_document_in_shared_workspace(
    capability: Video[object], files: FakeFileStore, understanding: FakeUnderstanding
) -> None:
    messages = await invoke(capability, "video_parser", {"video_url": VIDEO})

    assert refusals(messages) == []
    assert understanding.calls == [VIDEO]
    stored = await files.read(NAMESPACE, video_doc_path(VIDEO))
    assert stored is not None
    assert stored.content == DOCUMENT
    delivered = returns(messages)
    assert len(delivered) == 1
    assert delivered[0].outcome == "success"
    assert video_doc_path(VIDEO) in str(delivered[0].content)
    assert await files.entries(OTHER_NAMESPACE) == []


@pytest.mark.parametrize("case", ["unregistered", "wrong-kind", "other-conversation"])
async def test_parse_rejects_invalid_material_before_understanding(
    capability: Video[object],
    files: FakeFileStore,
    materials: FakeMaterialLedger,
    understanding: FakeUnderstanding,
    case: str,
) -> None:
    url = "https://cdn.test/not-authorized.mp4"
    if case == "wrong-kind":
        materials.rows[(NAMESPACE, url)] = Material(url=url, kind="image")
    elif case == "other-conversation":
        materials.rows[(OTHER_NAMESPACE, url)] = Material(url=url, kind="video")

    messages = await invoke(capability, "video_parser", {"video_url": url})

    rejected = refusals(messages)
    assert len(rejected) == 1
    assert url not in rejected[0].model_response()
    assert understanding.calls == []
    assert await files.entries(NAMESPACE) == []
    assert await files.entries(OTHER_NAMESPACE) == []


@pytest.mark.parametrize("url", ["reference.mp4", "file:///etc/passwd", "ftp://host/ref.mp4"])
async def test_parse_rejects_non_http_addresses_before_understanding(
    capability: Video[object],
    files: FakeFileStore,
    understanding: FakeUnderstanding,
    url: str,
) -> None:
    messages = await invoke(capability, "video_parser", {"video_url": url})

    assert len(refusals(messages)) == 1
    assert understanding.calls == []
    assert await files.entries(NAMESPACE) == []


async def test_parse_failure_preserves_existing_document(
    capability: Video[object], files: FakeFileStore, understanding: FakeUnderstanding
) -> None:
    await files.write(NAMESPACE, video_doc_path(VIDEO), DOCUMENT)
    original = await files.read(NAMESPACE, video_doc_path(VIDEO))
    understanding.error = VideoUnderstandingError("理解服务未完成")

    messages = await invoke(capability, "video_parser", {"video_url": VIDEO})

    assert len(refusals(messages)) == 1
    assert understanding.calls == [VIDEO]
    assert await files.read(NAMESPACE, video_doc_path(VIDEO)) == original
    assert returns(messages) == []


async def test_files_land_in_the_normalized_namespace(
    files: FakeFileStore, materials: FakeMaterialLedger, understanding: FakeUnderstanding
) -> None:
    """共享 FileSpace 的能力必须使用归一化命名空间，否则工作区工具无法读取产物。"""

    toolset = Video[object](
        space=FileSpace(store=files, namespace=lambda _ctx: f"{USER}//thread-1"),
        ledger=materials,
        understanding=understanding,
    ).get_toolset()

    await toolset.video_parser(make_context(make_deps()), VIDEO)
    assert await files.read(NAMESPACE, video_doc_path(VIDEO)) is not None


async def test_missing_run_identity_is_a_bug_not_a_retry(tools: VideoToolset[object]) -> None:
    """deps 类型错误属于装配故障，模型重试无法修复。"""

    with pytest.raises(RuntimeError, match="AgentRunDeps"):
        await tools.video_parser(make_context(object()), VIDEO)


async def test_delivered_table_lands_in_the_workspace(
    tools: VideoToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> None:
    shots = [one_shot(), one_shot(index=2, seconds=12, image_urls=[FRAME_URL, OTHER_FRAME_URL])]
    result = await deliver(tools, ctx, shots)

    assert SHOTS_PATH in result
    assert "20 秒" in result
    stored = await files.read(NAMESPACE, SHOTS_PATH)
    assert stored is not None
    document = json.loads(stored.content)
    expected_rows = [shot.model_dump(mode="json") for shot in shots]
    for row in expected_rows:
        row["prompt"]["timeline"][0]["image_indexes"] = [1]
    assert document == {"aspect_ratio": "9:16", "shots": expected_rows}
    validate_shots_document(stored.content)


async def test_delivered_table_accepts_a_group_without_reference_images(
    tools: VideoToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> None:
    shot = one_shot(
        prompt={
            "global_settings": "人物与门厅保持一致。",
            "timeline": [{"timestamps": [0, 8], "prompt": " 她走进门厅。\n"}],
        },
        image_urls=[],
    )
    await check_args(tools, "write_video_shots", ctx, aspect_ratio="9:16", shots=[shot])

    result = await deliver(tools, ctx, [shot])

    assert SHOTS_PATH in result
    stored = await files.read(NAMESPACE, SHOTS_PATH)
    assert stored is not None
    expected = shot.model_dump(mode="json")
    expected["prompt"]["timeline"][0]["image_indexes"] = []
    assert json.loads(stored.content) == {"aspect_ratio": "9:16", "shots": [expected]}
    validate_shots_document(stored.content)


@pytest.mark.parametrize(
    ("shots", "message"),
    [
        ([], "一条都没有"),
        ([one_shot(index=2)], "连续编号"),
        (
            [
                one_shot(
                    prompt={
                        "global_settings": "人物与门厅保持一致。",
                        "timeline": [{"timestamps": [0, 8], "prompt": "   "}],
                    }
                )
            ],
            "prompt 为空",
        ),
        ([one_shot(seconds=3)], "4-30"),
        ([one_shot(seconds=31)], "4-30"),
        ([one_shot(image_urls=[])], "@Image1"),
        (
            [
                one_shot(
                    prompt={
                        "global_settings": "人物与门厅保持一致。",
                        "timeline": [{"timestamps": [0, 8], "prompt": "她走进门厅 @Image2。"}],
                    }
                )
            ],
            "@Image2",
        ),
    ],
)
async def test_delivery_rejects_the_whole_table(
    tools: VideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    shots: list[VideoShotRequest],
    message: str,
) -> None:
    with pytest.raises(ModelRetry, match=message):
        await deliver(tools, ctx, shots)
    assert await files.read(NAMESPACE, SHOTS_PATH) is None


async def test_invalid_later_group_preserves_the_complete_existing_file(
    tools: VideoToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> None:
    original = shots_document()
    written = await files.write(NAMESPACE, SHOTS_PATH, original)
    shots = [one_shot(seconds=12), one_shot(index=2, image_urls=[])]

    with pytest.raises(ModelRetry, match=r"镜头组 2.*@Image1"):
        await deliver(tools, ctx, shots)

    stored = await files.read(NAMESPACE, SHOTS_PATH)
    assert stored is not None
    assert (stored.content, stored.version) == (original, written.version)


async def test_delivery_rejects_a_bad_aspect_ratio(
    tools: VideoToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> None:
    with pytest.raises(ModelRetry, match="画幅"):
        await deliver(tools, ctx, [one_shot()], aspect_ratio="竖版")
    assert await files.read(NAMESPACE, SHOTS_PATH) is None


async def test_delivery_accepts_a_registered_frame_url(
    tools: VideoToolset[object], ctx: RunContext[object]
) -> None:
    await check_args(tools, "write_video_shots", ctx, aspect_ratio="9:16", shots=[one_shot()])


async def test_delivery_rejects_a_made_up_frame_url(
    tools: VideoToolset[object], ctx: RunContext[object]
) -> None:
    """拒绝未登记帧地址，错误仅提示合法来源，不回显该地址。"""

    with pytest.raises(ModelRetry, match="不要自己拼。") as rejected:
        await check_args(
            tools,
            "write_video_shots",
            ctx,
            aspect_ratio="9:16",
            shots=[one_shot(image_urls=["https://cdn.test/编的.jpg"])],
        )
    assert "编的" not in str(rejected.value), "被拒的地址不回显，否则重试一次就洗成素材了"


async def test_delivery_rejects_a_frame_url_that_is_not_http(
    tools: VideoToolset[object], ctx: RunContext[object]
) -> None:
    with pytest.raises(ModelRetry, match="http"):
        await check_args(
            tools,
            "write_video_shots",
            ctx,
            aspect_ratio="9:16",
            shots=[one_shot(image_urls=["frames/s1-1.jpg"])],
        )


@pytest.mark.parametrize("case", ["unregistered", "wrong-kind", "other-conversation"])
async def test_delivery_rejects_invalid_reference_material_without_writing(
    capability: Video[object],
    files: FakeFileStore,
    materials: FakeMaterialLedger,
    case: str,
) -> None:
    url = "https://cdn.test/not-authorized.jpg"
    if case == "wrong-kind":
        materials.rows[(NAMESPACE, url)] = Material(url=url, kind="video")
    elif case == "other-conversation":
        materials.rows[(OTHER_NAMESPACE, url)] = Material(url=url, kind="image")

    messages = await invoke(capability, "write_video_shots", shot_payload([url]))

    rejected = refusals(messages)
    assert len(rejected) == 1
    assert url not in rejected[0].model_response()
    assert await files.entries(NAMESPACE) == []
    assert await files.entries(OTHER_NAMESPACE) == []


@pytest.mark.parametrize("count", [0, 1, MAX_REFERENCE_IMAGES])
async def test_delivery_accepts_reference_count_boundaries(
    capability: Video[object],
    files: FakeFileStore,
    materials: FakeMaterialLedger,
    count: int,
) -> None:
    urls = [f"https://cdn.test/user-{index}.jpg" for index in range(count)]
    await materials.record(NAMESPACE, [Material(url=url, kind="image") for url in urls])

    messages = await invoke(capability, "write_video_shots", shot_payload(urls))

    assert refusals(messages) == []
    stored = await files.read(NAMESPACE, SHOTS_PATH)
    assert stored is not None
    assert json.loads(stored.content)["shots"][0]["image_urls"] == urls


async def test_delivery_rejects_more_references_than_the_cap(
    capability: Video[object], files: FakeFileStore, materials: FakeMaterialLedger
) -> None:
    urls = [f"https://cdn.test/user-{index}.jpg" for index in range(MAX_REFERENCE_IMAGES + 1)]
    await materials.record(NAMESPACE, [Material(url=url, kind="image") for url in urls])

    messages = await invoke(capability, "write_video_shots", shot_payload(urls))

    assert len(refusals(messages)) == 1
    assert await files.read(NAMESPACE, SHOTS_PATH) is None


@pytest.mark.parametrize(
    "prompt",
    [
        "0-8s 她走进门厅 @Image1。",
        {
            "global_settings": "人物与门厅保持一致。",
            "timeline": [
                {"timestamps": [0, 5], "prompt": "她走进门厅 @Image1。"},
                {"timestamps": [4, 8], "prompt": "她停下脚步 @Image1。"},
            ],
        },
    ],
    ids=["string-prompt", "overlapping-timeline"],
)
async def test_invalid_shot_input_keeps_the_existing_file_on_the_agent_path(
    capability: Video[object], files: FakeFileStore, prompt: object
) -> None:
    original = shots_document()
    await files.write(NAMESPACE, SHOTS_PATH, original)
    shot = one_shot().model_dump()
    shot["prompt"] = prompt

    refusals_seen, _ = await run_delivery_once(capability, [shot])

    assert len(refusals_seen) == 1
    stored = await files.read(NAMESPACE, SHOTS_PATH)
    assert stored is not None
    assert stored.content == original


async def run_delivery_once(
    capability: Video[object], shots: object
) -> tuple[list[RetryPromptPart], list[EventDict]]:
    """让模型只调一次交付工具，返回它收到的退回单与本次的日志。"""

    def call_once(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        if len(messages) == 1:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        "write_video_shots",
                        {"aspect_ratio": "9:16", "shots": shots},
                        tool_call_id="c1",
                    )
                ]
            )
        return ModelResponse(parts=[TextPart("好")])

    with capture_logs() as logs:
        result = await Agent(FunctionModel(call_once), capabilities=[capability]).run(
            "提交镜头组", deps=make_deps()
        )
    rejected = [
        part
        for message in result.all_messages()
        for part in message.parts
        if isinstance(part, RetryPromptPart) and part.tool_name == "write_video_shots"
    ]
    return rejected, logs


@pytest.mark.parametrize("field", ["shots", "prompt"])
async def test_stringified_nested_input_is_parsed_on_the_agent_path(
    capability: Video[object], files: FakeFileStore, field: str
) -> None:
    """弱模型把嵌套结构整体序列化成字符串时照常交付，并留一条可数的日志。"""

    shot = one_shot().model_dump()
    shots: object
    if field == "prompt":
        shot["prompt"] = json.dumps(shot["prompt"], ensure_ascii=False)
        shots = [shot]
    else:
        shots = json.dumps([shot], ensure_ascii=False)

    rejected, logs = await run_delivery_once(capability, shots)

    assert rejected == []
    stored = await files.read(NAMESPACE, SHOTS_PATH)
    assert stored is not None
    validate_shots_document(stored.content)
    parsed = [log for log in logs if log["event"] == "工具参数以字符串传入，已解析"]
    assert [log["field"] for log in parsed] == [field]


async def test_a_string_that_is_not_json_is_refused_and_keeps_the_file(
    capability: Video[object], files: FakeFileStore
) -> None:
    original = shots_document()
    await files.write(NAMESPACE, SHOTS_PATH, original)

    rejected, _ = await run_delivery_once(capability, "index: 1, seconds: 8")

    assert len(rejected) == 1
    stored = await files.read(NAMESPACE, SHOTS_PATH)
    assert stored is not None
    assert stored.content == original


@pytest.mark.parametrize("tool_name", ["video_parser", "write_video_shots"])
async def test_quota_failure_preserves_existing_file(
    materials: FakeMaterialLedger, understanding: FakeUnderstanding, tool_name: str
) -> None:
    files = FakeFileStore(max_file_bytes=4096)
    capability = Video[object](
        space=FileSpace(store=files, namespace=workspace_namespace),
        ledger=materials,
        understanding=understanding,
    )
    args: dict[str, Any] = (
        {"video_url": VIDEO} if tool_name == "video_parser" else shot_payload([FRAME_URL])
    )
    path = video_doc_path(VIDEO) if tool_name == "video_parser" else SHOTS_PATH
    first = await invoke(capability, tool_name, args)
    assert refusals(first) == []
    original = await files.read(NAMESPACE, path)
    assert original is not None
    if tool_name == "video_parser":
        understanding.document = DOCUMENT * 1000
    else:
        args["shots"][0]["prompt"]["global_settings"] += "产品特征。" * 1000

    messages = await invoke(capability, tool_name, args)

    assert len(refusals(messages)) == 1
    assert await files.read(NAMESPACE, path) == original
    assert returns(messages) == []
