"""验证方舟视频拆解适配器的请求形状、响应校验与拆解文档路径。"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from iclip.capabilities.video_document import video_doc_path
from iclip.capabilities.video_understanding import (
    SYSTEM_PROMPT,
    ArkVideoUnderstanding,
    VideoUnderstandingError,
)

VIDEO = "https://cdn.test/ref.mp4"


def test_document_path_survives_two_videos_of_the_same_name() -> None:

    assert video_doc_path("https://a.test/ref.mp4") != video_doc_path("https://b.test/ref.mp4")


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
