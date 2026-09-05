"""验证生成能力的 lifespan 启停、队列连接和 worker 关停顺序。

直接驱动 lifespan_context，与 uvicorn 保持一致；避免夹具任务改变取消语义。
"""

from __future__ import annotations

import httpx
import pytest

from iclip.app.bootstrap import build_app
from iclip.config import (
    ImageGenerationSection,
    MediaGenerationSection,
    RuntimeConfig,
    VideoGenerationSection,
)
from tests.helpers.generation import MemoryObjectStore
from tests.integration_no_llm.conftest import make_runtime_config

MEDIA_ENVS = {
    "OSS_BUCKET": "iclip-test",
    "OSS_ENDPOINT": "oss-cn-hangzhou.aliyuncs.com",
    "OSS_ACCESS_KEY_ID": "ak",
    "OSS_ACCESS_KEY_SECRET": "sk",
    "OSS_PUBLIC_URL_BASE": "https://cdn.example.test",
    "VIDEO_SUBMIT_URL": "https://video.test/submit",
    "VIDEO_STATUS_BASE_URL": "https://video.test/status",
    "VIDEO_API_KEY": "vk",
    "IMAGE_TEXT_TO_IMAGE_URL": "https://image.test/text-to-image",
    "IMAGE_EDIT_URL": "https://image.test/image-edit",
}


def config_with_media() -> RuntimeConfig:
    return make_runtime_config().model_copy(
        update={
            "media_generation": MediaGenerationSection(
                video=VideoGenerationSection(model="seedance", user_name="iclip-agent"),
                image=ImageGenerationSection(user_name="iclip-agent"),
            ),
        }
    )


async def test_app_with_generation_starts_and_stops_cleanly(
    base_env: None, migrated_pg: str, monkeypatch: pytest.MonkeyPatch
) -> None:

    for name, value in MEDIA_ENVS.items():
        monkeypatch.setenv(name, value)

    # 对象存储使用替身；队列连接真实测试数据库，覆盖完整 lifespan。
    app = build_app(config_with_media(), object_store=MemoryObjectStore())

    lifespan = app.router.lifespan_context(app)
    await lifespan.__aenter__()
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            assert (await client.get("/healthz")).status_code == 200
            assert (await client.get("/generations")).status_code == 401, "路由挂上了"
    finally:
        await lifespan.__aexit__(None, None, None)
