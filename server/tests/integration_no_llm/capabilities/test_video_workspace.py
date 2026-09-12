"""video 能力经真实 Postgres 文件存储与素材台账的往返：拆解文档与镜头组表落库，写回校验认得它。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from typing import Any

import pytest
from pydantic_ai import Agent
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ToolCallPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from iclip.capabilities.shot_document import SHOTS_PATH, validate_shots_document
from iclip.capabilities.video.capability import Video
from iclip.capabilities.video_document import video_doc_path
from iclip.capabilities.workspace.scope import workspace_namespace
from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.identity.models import Principal
from iclip.platform.file_store.pg import PgFileStore
from iclip.platform.file_store.store import FileSpace
from iclip.platform.material_ledger.pg import PgMaterialLedger
from iclip.platform.material_ledger.store import Material
from tests.helpers.pg import truncate_clean
from tests.helpers.shot_video import FakeUnderstanding

USER = uuid.UUID("44444444-4444-4444-4444-444444444444")
VIDEO = "https://cdn.test/ref.mp4"
FRAME = "https://cdn.test/frames/s1-1.jpg"
DOCUMENT = "## 逐镜拉片表\n**[00:00.000-00:08.000]** 她走进门厅。"
SHOTS: dict[str, Any] = {
    "aspect_ratio": "9:16",
    "shots": [
        {
            "index": 1,
            "prompt": {
                "global_settings": "人物与门厅保持一致。",
                "timeline": [
                    {"timestamps": [0, 8], "prompt": "全景，平视，固定，她走进门厅 @Image1。"}
                ],
            },
            "seconds": 8,
            "image_urls": [FRAME],
        }
    ],
}


@pytest.fixture
async def engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    engine = create_async_engine(migrated_pg)
    async with engine.begin() as conn:
        await truncate_clean(conn, ("agent_runtime.workspace_files", "agent_runtime.materials"))
    yield engine
    await engine.dispose()


@pytest.fixture
def conversation_id() -> str:
    return f"c-{uuid.uuid4().hex[:8]}"


def make_deps(conversation_id: str) -> AgentRunDeps:
    return AgentRunDeps(
        principal=Principal(
            kind="user",
            user_id=USER,
            permissions=frozenset({"agent:run"}),
            audit_label="luke",
            api_key_id=None,
        ),
        conversation_id=conversation_id,
        user_name="luke",
    )


async def call_once(
    capability: Video[object], conversation_id: str, tool_name: str, args: str | dict[str, Any]
) -> list[RetryPromptPart]:
    """模型只调一次工具，返回它收到的退回单。"""

    def script(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        if len(messages) == 1:
            return ModelResponse(parts=[ToolCallPart(tool_name, args, tool_call_id="c1")])
        return ModelResponse(parts=[TextPart("好")])

    result = await Agent(FunctionModel(script), capabilities=[capability]).run(
        "处理参考素材。", deps=make_deps(conversation_id)
    )
    return [
        part
        for message in result.all_messages()
        for part in message.parts
        if isinstance(part, RetryPromptPart)
    ]


def make_video(engine: AsyncEngine) -> tuple[Video[object], PgFileStore, PgMaterialLedger]:
    files = PgFileStore(engine)
    ledger = PgMaterialLedger(engine)
    capability = Video[object](
        space=FileSpace(store=files, namespace=workspace_namespace),
        ledger=ledger,
        understanding=FakeUnderstanding(document=DOCUMENT),
    )
    return capability, files, ledger


async def test_parse_then_deliver_round_trips_through_postgres(
    engine: AsyncEngine, conversation_id: str
) -> None:
    capability, files, ledger = make_video(engine)
    namespace = f"{USER}/{conversation_id}"
    await ledger.record(
        namespace, [Material(url=VIDEO, kind="video"), Material(url=FRAME, kind="image")]
    )

    assert await call_once(capability, conversation_id, "video_parser", {"video_url": VIDEO}) == []
    parsed = await files.read(namespace, video_doc_path(VIDEO))
    assert parsed is not None
    assert parsed.content == DOCUMENT

    assert await call_once(capability, conversation_id, "write_video_shots", SHOTS) == []
    stored = await files.read(namespace, SHOTS_PATH)
    assert stored is not None
    assert stored.version == 1
    # 用户在面板写回走的是同一个校验入口，工具交付的文件必须原样通过。
    document = validate_shots_document(stored.content)
    assert document.shots[0].image_urls == [FRAME]
    assert document.shots[0].prompt.timeline[0].image_indexes == [1]


async def test_an_unregistered_frame_is_refused_before_touching_the_store(
    engine: AsyncEngine, conversation_id: str
) -> None:
    capability, files, ledger = make_video(engine)
    namespace = f"{USER}/{conversation_id}"
    await ledger.record(namespace, [Material(url=VIDEO, kind="video")])

    refusals = await call_once(capability, conversation_id, "write_video_shots", SHOTS)

    assert len(refusals) == 1
    assert FRAME not in refusals[0].model_response()
    assert await files.read(namespace, SHOTS_PATH) is None
