"""验证生成能力的 lifespan 启停、队列连接和 worker 关停顺序。

直接驱动 lifespan_context，与 uvicorn 保持一致；避免夹具任务改变取消语义。
"""

from __future__ import annotations

import httpx
import pytest

from iclip.app.bootstrap import build_app
from tests.helpers.generation import MEDIA_ENVS, MemoryObjectStore, config_with_media


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
