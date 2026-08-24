"""T-GEN-01：生成请求的校验与入库/读回往返。

重点不是「校验有没有」，而是**只有一套定义**：HTTP 提交进得来的东西，重启后从库里
读回来必须照样合法，否则 worker 会在半路上崩在一个几分钟前才写下的行上。
"""

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
    """``kind`` 是表上的一列，不重复存进 JSON。"""

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
    """上限在提交之前就拦住：多一张就多一次付费调用白扔。"""

    urls = [f"https://example.test/{i}.png" for i in range(IMAGE_MAX_REFERENCES + 1)]
    with pytest.raises(ValueError):
        image_request(reference_image_urls=urls)


def test_non_http_reference_url_is_rejected() -> None:
    """参考 URL 会被 provider 拿去下载，放行 file:// 等于开一个任意文件读取入口。"""

    with pytest.raises(ValueError):
        VideoGenerationIn(
            prompt="猫",
            aspect_ratio="16:9",
            duration_seconds=5,
            image_urls=["file:///etc/passwd"],
        )


def test_request_is_frozen() -> None:
    """请求是值：一次生成的输入落库之后不该再被改。"""

    with pytest.raises(ValueError):
        video_request().prompt = "改了"  # type: ignore[misc]


@pytest.mark.parametrize(
    "damaged",
    [
        {"prompt": "猫", "durationSeconds": 5},  # 少了 aspectRatio
        {"prompt": "猫", "aspectRatio": "16:9", "durationSeconds": "五秒"},
        {"prompt": "猫", "aspectRatio": "7:3", "durationSeconds": 5},
    ],
)
def test_damaged_persisted_shape_fails_loudly(damaged: dict[str, object]) -> None:
    """库里的行形状坏了要大声失败，不降级成一个「空请求」继续跑。"""

    with pytest.raises(ValidationFailed, match="形状不合法"):
        request_from_payload(KIND_VIDEO, damaged)


def test_model_and_channel_are_part_of_the_stored_request() -> None:
    """用了哪个模型 / 哪个渠道是这次生成的输入事实，要跟着行一起存下来。

    这两个字段各照对方真实的那个轴：视频那家的模型是请求体里的参数；图片那家的模型
    写死在接口地址里，真正可选的是 dev/pro 渠道（而且两个渠道价钱不一样）。
    """

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
    """渠道是封闭的两个值，能枚举就枚举；模型名是对方说了算的，本仓不维护白名单。"""

    with pytest.raises(ValueError):
        image_request(channel="prod")
    assert video_request(model="随便一个对方认的名字").model is not None
    with pytest.raises(ValueError):
        video_request(model="")
