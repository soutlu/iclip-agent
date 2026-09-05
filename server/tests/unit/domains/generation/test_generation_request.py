"""验证 HTTP 请求与持久化负载共用校验定义，确保 worker 可读取已受理请求。"""

from __future__ import annotations

import pytest

from iclip.common.errors import ValidationFailed
from iclip.domains.generation.schemas import (
    IMAGE_MAX_REFERENCES,
    KIND_IMAGE,
    KIND_VIDEO,
    VIDEO_MAX_SECONDS,
    ImageGenerationIn,
    VideoGenerationIn,
    request_from_payload,
    request_to_payload,
)
from tests.helpers.generation import image_request, video_request


def test_payload_round_trip_video() -> None:
    original = video_request(
        image_urls=["https://example.test/a.png"],
        reference_audio_urls=["https://example.test/a.mp3"],
    )
    assert request_from_payload(KIND_VIDEO, request_to_payload(original)) == original


def test_payload_round_trip_image() -> None:
    original = image_request(resolution="2k", reference_image_urls=["https://example.test/ref.png"])
    assert request_from_payload(KIND_IMAGE, request_to_payload(original)) == original


def test_stored_payload_is_camel_case_without_the_kind_column() -> None:

    payload = request_to_payload(video_request())
    assert "kind" not in payload
    assert set(payload) == {
        "prompt",
        "model",
        "aspectRatio",
        "durationSeconds",
        "imageUrls",
        "referenceVideoUrls",
        "referenceAudioUrls",
    }
    assert set(request_to_payload(image_request())) == {
        "prompt",
        "channel",
        "aspectRatio",
        "resolution",
        "referenceImageUrls",
    }


def test_unknown_kind_is_rejected() -> None:
    with pytest.raises(ValidationFailed, match="未知的生成类型"):
        request_from_payload("audio", {"prompt": "x"})


@pytest.mark.parametrize(
    "overrides",
    [
        {"aspect_ratio": "7:3"},
        {"duration_seconds": 0},
        {"duration_seconds": VIDEO_MAX_SECONDS + 1},
        {"prompt": ""},
    ],
)
def test_video_request_rejects_bad_values(overrides: dict[str, object]) -> None:
    with pytest.raises(ValueError):
        video_request(**overrides)


def test_image_request_rejects_bad_resolution() -> None:
    with pytest.raises(ValueError):
        ImageGenerationIn(prompt="猫", aspect_ratio="1:1", resolution="8k")  # type: ignore[arg-type]


def test_image_request_caps_reference_count() -> None:

    urls = [f"https://example.test/{i}.png" for i in range(IMAGE_MAX_REFERENCES + 1)]
    with pytest.raises(ValueError):
        image_request(reference_image_urls=urls)


def test_non_http_reference_url_is_rejected() -> None:
    """参考 URL 由供应商下载，只接受 HTTP(S)，避免 file:// 等协议访问本地文件。"""

    with pytest.raises(ValueError):
        VideoGenerationIn(
            prompt="猫",
            aspect_ratio="16:9",
            duration_seconds=5,
            image_urls=["file:///etc/passwd"],
        )


def test_request_is_frozen() -> None:

    with pytest.raises(ValueError):
        video_request().prompt = "改了"  # type: ignore[misc]


@pytest.mark.parametrize(
    "damaged",
    [
        {"prompt": "猫", "durationSeconds": 5},
        {"prompt": "猫", "aspectRatio": "16:9", "durationSeconds": "五秒"},
        {"prompt": "猫", "aspectRatio": "7:3", "durationSeconds": 5},
    ],
)
def test_damaged_persisted_shape_fails_loudly(damaged: dict[str, object]) -> None:

    with pytest.raises(ValidationFailed, match="形状不合法"):
        request_from_payload(KIND_VIDEO, damaged)


def test_model_and_channel_are_part_of_the_stored_request() -> None:
    """持久化实际模型与渠道：视频模型为请求参数，图片接口固定模型并通过 dev/pro 选择渠道。"""

    video = video_request(model="mmt-seedance-3-0")
    assert request_to_payload(video)["model"] == "mmt-seedance-3-0"
    assert request_from_payload(KIND_VIDEO, request_to_payload(video)) == video

    image = image_request(channel="pro")
    assert request_to_payload(image)["channel"] == "pro"
    assert request_from_payload(KIND_IMAGE, request_to_payload(image)) == image


def test_model_is_optional_but_channel_always_has_a_value() -> None:
    assert video_request().model is None, "不给就用配置里的默认模型"
    assert image_request().channel == "dev"


def test_bad_channel_is_rejected_but_model_is_free_form() -> None:
    """渠道为封闭枚举；模型名由供应商定义，不维护本地白名单。"""

    with pytest.raises(ValueError):
        image_request(channel="prod")
    assert video_request(model="随便一个对方认的名字").model is not None
    with pytest.raises(ValueError):
        video_request(model="")
