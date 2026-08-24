"""T-GENBOOT-02：开着生成能力时，整个 app 的 lifespan 起得来、也收得干净。

别的测试用 ``ASGITransport`` 直接打路由，**lifespan 根本没跑**——而队列连接的开关、
三个 worker 的起停、以及它们和 engine 的关停顺序全在那里面。这一段没人验的话，单测
全绿而线上启动就挂，或者关停时报一串「连接已关但还有人在用」。

直接驱动 ``lifespan_context``（uvicorn 就是这么调的），不套 ``LifespanManager``：后者
把 lifespan 放进它自己的任务里，取消语义跟真实进程不一样——实测过，同一段代码在它下
面二十秒收不干净，而直接驱动是瞬时的。要测的是我们的关停顺序，不是那个夹具。
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
    """真库、真连接器、真 worker：进得去也出得来，路由还在。"""

    for name, value in MEDIA_ENVS.items():
        monkeypatch.setenv(name, value)

    # 对象存储用替身：装真 OSS 客户端要真凭证，而这里验的是 lifespan。队列连接器不
    # 注入——它连的就是这个真库，那正是要验的东西。
    app = build_app(config_with_media(), object_store=MemoryObjectStore())

    lifespan = app.router.lifespan_context(app)
    await lifespan.__aenter__()
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            assert (await client.get("/healthz")).status_code == 200
            assert (await client.get("/generations")).status_code == 401, "路由挂上了"
    finally:
        # 走一遍关停：worker、队列连接、engine 依次收掉。
        await lifespan.__aexit__(None, None, None)
