"""通过真实 Agent 工具调用验证完全复刻的解析、素材范围与分镜交付。"""

from __future__ import annotations

import json
import uuid
from typing import Any

import pytest
from pydantic_ai import Agent
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel

from iclip.capabilities.exact_replica.capability import ExactReplica
from iclip.capabilities.shot_document import SHOTS_PATH
from iclip.capabilities.video_understanding import VideoUnderstandingError, video_doc_path
from iclip.capabilities.workspace.scope import workspace_namespace
from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.identity.models import Principal
from iclip.platform.file_store.store import FileSpace
from iclip.platform.material_ledger.store import Material
from tests.helpers.file_store import FakeFileStore
from tests.helpers.material_ledger import FakeMaterialLedger
from tests.helpers.shot_video import FakeUnderstanding

USER = uuid.UUID("33333333-3333-3333-3333-333333333333")
NAMESPACE = f"{USER}/replica-thread"
OTHER_NAMESPACE = f"{USER}/other-thread"
VIDEO_URL = "https://cdn.test/reference.mp4"
IMAGE_URL = "https://cdn.test/product.jpg"
DOCUMENT = "## 逐镜拉片表\n**[00:00.000-00:30.000]** 产品演示。"


@pytest.fixture
def files() -> FakeFileStore:
    return FakeFileStore()


@pytest.fixture
def materials() -> FakeMaterialLedger:
    ledger = FakeMaterialLedger()
    ledger.rows[(NAMESPACE, VIDEO_URL)] = Material(url=VIDEO_URL, kind="video")
    ledger.rows[(NAMESPACE, IMAGE_URL)] = Material(url=IMAGE_URL, kind="image")
    return ledger


@pytest.fixture
def understanding() -> FakeUnderstanding:
    return FakeUnderstanding(document=DOCUMENT)


@pytest.fixture
def replica(
    files: FakeFileStore, materials: FakeMaterialLedger, understanding: FakeUnderstanding
) -> ExactReplica[object]:
    return ExactReplica[object](
        space=FileSpace(store=files, namespace=workspace_namespace),
        ledger=materials,
        understanding=understanding,
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
        conversation_id="replica-thread",
        user_name="luke",
    )


def shot_args(image_urls: list[str] | None = None) -> dict[str, Any]:
    images = [IMAGE_URL] if image_urls is None else image_urls
    references = "、".join(f"@Image{index}" for index in range(1, len(images) + 1))
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
                "image_urls": images,
            }
        ],
    }


async def invoke(
    replica: ExactReplica[object], tool_name: str, args: dict[str, Any]
) -> list[ModelMessage]:
    """模型只调用一次工具，随后结束，保留注册校验器与工具返回的完整路径。"""

    def script(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        if len(messages) == 1:
            return ModelResponse(parts=[ToolCallPart(tool_name, args, tool_call_id="replica-call")])
        return ModelResponse(parts=[TextPart("本轮结束。")])

    result = await Agent(FunctionModel(script), capabilities=[replica]).run(
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


async def test_only_replica_tools_reach_the_model(replica: ExactReplica[object]) -> None:
    seen: list[str] = []

    def script(_messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        seen.extend(sorted(tool.name for tool in info.function_tools))
        return ModelResponse(parts=[TextPart("好")])

    await Agent(FunctionModel(script), capabilities=[replica]).run("查看工具。", deps=make_deps())

    assert seen == ["parse_reference_video", "write_replica_shots"]
    assert set(replica.display_table()) == set(seen)


async def test_parse_stores_document_in_shared_workspace(
    replica: ExactReplica[object], files: FakeFileStore, understanding: FakeUnderstanding
) -> None:
    messages = await invoke(replica, "parse_reference_video", {"video_url": VIDEO_URL})

    assert refusals(messages) == []
    assert understanding.calls == [VIDEO_URL]
    stored = await files.read(NAMESPACE, video_doc_path(VIDEO_URL))
    assert stored is not None
    assert stored.content == DOCUMENT
    delivered = returns(messages)
    assert len(delivered) == 1
    assert delivered[0].outcome == "success"
    assert video_doc_path(VIDEO_URL) in str(delivered[0].content)
    assert await files.entries(OTHER_NAMESPACE) == []


@pytest.mark.parametrize("case", ["unregistered", "wrong-kind", "other-conversation"])
async def test_parse_rejects_invalid_material_before_understanding(
    replica: ExactReplica[object],
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

    messages = await invoke(replica, "parse_reference_video", {"video_url": url})

    rejected = refusals(messages)
    assert len(rejected) == 1
    assert url not in rejected[0].model_response()
    assert understanding.calls == []
    assert await files.entries(NAMESPACE) == []
    assert await files.entries(OTHER_NAMESPACE) == []


@pytest.mark.parametrize("url", ["reference.mp4", "file:///etc/passwd", "ftp://host/ref.mp4"])
async def test_parse_rejects_non_http_addresses_before_understanding(
    replica: ExactReplica[object],
    files: FakeFileStore,
    understanding: FakeUnderstanding,
    url: str,
) -> None:
    messages = await invoke(replica, "parse_reference_video", {"video_url": url})

    assert len(refusals(messages)) == 1
    assert understanding.calls == []
    assert await files.entries(NAMESPACE) == []


async def test_parse_failure_preserves_existing_document(
    replica: ExactReplica[object], files: FakeFileStore, understanding: FakeUnderstanding
) -> None:
    await files.write(NAMESPACE, video_doc_path(VIDEO_URL), DOCUMENT)
    original = await files.read(NAMESPACE, video_doc_path(VIDEO_URL))
    understanding.error = VideoUnderstandingError("理解服务未完成")

    messages = await invoke(replica, "parse_reference_video", {"video_url": VIDEO_URL})

    assert len(refusals(messages)) == 1
    assert understanding.calls == [VIDEO_URL]
    assert await files.read(NAMESPACE, video_doc_path(VIDEO_URL)) == original
    assert returns(messages) == []


async def test_delivery_uses_global_user_references_for_a_thirty_second_group(
    replica: ExactReplica[object], files: FakeFileStore
) -> None:
    legacy = shot_args()
    for segment in legacy["shots"][0]["prompt"]["timeline"]:
        segment["image_indexes"] = []
    original = json.dumps(legacy, ensure_ascii=False)
    await files.write(NAMESPACE, SHOTS_PATH, original)
    existing = await files.read(NAMESPACE, SHOTS_PATH)
    args = shot_args()
    messages = await invoke(replica, "write_replica_shots", args)

    updated = await files.read(NAMESPACE, SHOTS_PATH)
    assert existing is not None and updated is not None
    assert updated.version == existing.version + 1

    assert refusals(messages) == []
    stored = await files.read(NAMESPACE, SHOTS_PATH)
    assert stored is not None
    expected = args["shots"][0]
    for segment in expected["prompt"]["timeline"]:
        segment["image_indexes"] = []
    assert json.loads(stored.content) == {"aspect_ratio": "9:16", "shots": [expected]}
    delivered = returns(messages)
    assert len(delivered) == 1
    assert delivered[0].outcome == "success"
    assert SHOTS_PATH in str(delivered[0].content)


@pytest.mark.parametrize("case", ["unregistered", "wrong-kind", "other-conversation"])
async def test_delivery_rejects_invalid_reference_material_without_writing(
    replica: ExactReplica[object],
    files: FakeFileStore,
    materials: FakeMaterialLedger,
    case: str,
) -> None:
    url = "https://cdn.test/not-authorized.jpg"
    if case == "wrong-kind":
        materials.rows[(NAMESPACE, url)] = Material(url=url, kind="video")
    elif case == "other-conversation":
        materials.rows[(OTHER_NAMESPACE, url)] = Material(url=url, kind="image")

    messages = await invoke(replica, "write_replica_shots", shot_args([url]))

    rejected = refusals(messages)
    assert len(rejected) == 1
    assert url not in rejected[0].model_response()
    assert await files.entries(NAMESPACE) == []
    assert await files.entries(OTHER_NAMESPACE) == []


@pytest.mark.parametrize("count", [1, 30])
async def test_delivery_accepts_reference_count_boundaries(
    replica: ExactReplica[object],
    files: FakeFileStore,
    materials: FakeMaterialLedger,
    count: int,
) -> None:
    urls = [f"https://cdn.test/user-{index}.jpg" for index in range(count)]
    await materials.record(NAMESPACE, [Material(url=url, kind="image") for url in urls])

    messages = await invoke(replica, "write_replica_shots", shot_args(urls))

    assert refusals(messages) == []
    stored = await files.read(NAMESPACE, SHOTS_PATH)
    assert stored is not None
    assert json.loads(stored.content)["shots"][0]["image_urls"] == urls


@pytest.mark.parametrize("count", [0, 31])
async def test_delivery_rejects_empty_or_excessive_references(
    replica: ExactReplica[object],
    files: FakeFileStore,
    materials: FakeMaterialLedger,
    count: int,
) -> None:
    urls = [f"https://cdn.test/user-{index}.jpg" for index in range(count)]
    await materials.record(NAMESPACE, [Material(url=url, kind="image") for url in urls])

    messages = await invoke(replica, "write_replica_shots", shot_args(urls))

    assert len(refusals(messages)) == 1
    assert await files.read(NAMESPACE, SHOTS_PATH) is None


@pytest.mark.parametrize("tool_name", ["parse_reference_video", "write_replica_shots"])
async def test_quota_failure_preserves_existing_file(
    materials: FakeMaterialLedger, understanding: FakeUnderstanding, tool_name: str
) -> None:
    files = FakeFileStore(max_file_bytes=4096)
    replica = ExactReplica[object](
        space=FileSpace(store=files, namespace=workspace_namespace),
        ledger=materials,
        understanding=understanding,
    )
    args: dict[str, Any] = (
        {"video_url": VIDEO_URL} if tool_name == "parse_reference_video" else shot_args()
    )
    path = video_doc_path(VIDEO_URL) if tool_name == "parse_reference_video" else SHOTS_PATH
    first = await invoke(replica, tool_name, args)
    assert refusals(first) == []
    original = await files.read(NAMESPACE, path)
    assert original is not None
    if tool_name == "parse_reference_video":
        understanding.document = DOCUMENT * 1000
    else:
        args["shots"][0]["prompt"]["global_settings"] += "产品特征。" * 1000

    messages = await invoke(replica, tool_name, args)

    assert len(refusals(messages)) == 1
    assert await files.read(NAMESPACE, path) == original
    assert returns(messages) == []
