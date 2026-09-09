"""验证 HTTP 请求与持久化负载共用校验定义，确保 worker 可读取已受理请求。"""

from __future__ import annotations

import uuid

import pytest

from iclip.common.errors import ValidationFailed
from iclip.domains.generation.schemas import (
    IMAGE_MAX_REFERENCES,
    KIND_IMAGE,
    KIND_VIDEO,
    ImageGenerationIn,
    VideoGenerationIn,
    request_from_payload,
    request_to_payload,
)
from tests.helpers.generation import image_request, video_request


def test_payload_round_trip_video() -> None:
    original = video_request(
        reference_image_urls=["https://example.test/a.png"],
        reference_audio_urls=["https://example.test/a.mp3"],
        resolution="1080p",
        provider_options={"output_format": "mov"},
    )
    assert request_from_payload(KIND_VIDEO, request_to_payload(original)) == original


@pytest.mark.parametrize("generate_audio", [True, False, None])
def test_video_audio_choice_survives_payload_round_trip(generate_audio: bool | None) -> None:
    original = video_request(generate_audio=generate_audio)

    payload = request_to_payload(original)

    assert payload["generate_audio"] is generate_audio
    assert request_from_payload(KIND_VIDEO, payload) == original


def test_payload_round_trip_image() -> None:
    original = image_request(resolution="2k", reference_image_urls=["https://example.test/ref.png"])
    assert request_from_payload(KIND_IMAGE, request_to_payload(original)) == original


def test_stored_payload_keeps_each_kinds_own_field_names() -> None:
    """视频照上游 snake_case，图片是本系统的 camelCase；kind 与归属字段都不进 JSON。"""

    payload = request_to_payload(video_request())
    assert "kind" not in payload
    assert set(payload) == {
        "model",
        "prompt",
        "user_name",
        "reference_image_urls",
        "reference_video_urls",
        "reference_audio_urls",
        "generate_audio",
        "resolution",
        "aspect_ratio",
        "seconds",
        "provider_options",
    }
    assert set(request_to_payload(image_request())) == {
        "prompt",
        "userName",
        "model",
        "channel",
        "aspectRatio",
        "resolution",
        "referenceImageUrls",
        "frameNumber",
    }


def test_a_stored_request_reads_back_without_its_origin_columns() -> None:
    """归属字段落列不落 JSON，所以读回时看不到——校验不能建在这条路上。"""

    task_id = uuid.uuid4()
    image = request_to_payload(image_request(shot_index=1, frame_number=2, task_id=task_id))
    assert {"shotIndex", "taskId", "conversationId"}.isdisjoint(image)
    restored = request_from_payload(KIND_IMAGE, image)
    assert isinstance(restored, ImageGenerationIn)
    assert restored.frame_number == 2

    video = request_to_payload(video_request(conversation_id=uuid.uuid4(), task_id=task_id))
    assert {"conversation_id", "shot_index", "task_id"}.isdisjoint(video)


def test_unknown_kind_is_rejected() -> None:
    with pytest.raises(ValidationFailed, match="未知的生成类型"):
        request_from_payload("audio", {"prompt": "x"})


@pytest.mark.parametrize(
    "overrides",
    [
        {"seconds": -2},
        {"prompt": ""},
        {"model": ""},
        {"user_name": "   "},
        {"reference_image_urls": ["file:///etc/passwd"]},
        {"image_urls": ["https://example.test/a.png"]},
        {"session_id": "s-1"},
    ],
)
def test_video_request_rejects_what_we_can_judge_ourselves(overrides: dict[str, object]) -> None:
    """上游的废弃别名与它会丢弃的字段，在我们这里是未知字段，直接拒。"""

    with pytest.raises(ValueError):
        video_request(**overrides)


@pytest.mark.parametrize(
    "overrides",
    [
        {"aspect_ratio": "7:3"},
        {"seconds": 0},
        {"seconds": -1},
        {"seconds": 600},
        {"resolution": "1440p-SR"},
        {"provider_options": {"omni_reference_task_type": "edit"}},
    ],
)
def test_video_request_leaves_model_specific_ranges_to_upstream(
    overrides: dict[str, object],
) -> None:
    """画幅、时长范围、分辨率、私有参数由上游按模型判，这里原样收下。"""

    assert video_request(**overrides) is not None


def test_video_request_strips_the_user_name() -> None:
    assert video_request(user_name=" luke ").user_name == "luke"
    assert video_request(user_name=None).user_name is None, "HTTP 边界会填，模型本身允许空"


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
            model="moyu-seedance-2-5",
            prompt="猫",
            reference_video_urls=["file:///etc/passwd"],
        )


def test_request_is_frozen() -> None:

    with pytest.raises(ValueError):
        video_request().prompt = "改了"  # type: ignore[misc]


@pytest.mark.parametrize(
    "damaged",
    [
        {"prompt": "猫"},
        {"model": "m", "prompt": "猫", "seconds": "五秒"},
        {"model": "m", "prompt": "猫", "aspectRatio": "16:9"},
    ],
)
def test_damaged_persisted_shape_fails_loudly(damaged: dict[str, object]) -> None:

    with pytest.raises(ValidationFailed, match="形状不合法"):
        request_from_payload(KIND_VIDEO, damaged)


def test_model_and_channel_are_part_of_the_stored_request() -> None:
    """持久化实际模型与渠道：视频模型为请求参数，图片按 model 选家并通过 dev/pro 选择渠道。"""

    video = video_request(model="mmt-seedance-3-0")
    assert request_to_payload(video)["model"] == "mmt-seedance-3-0"
    assert request_from_payload(KIND_VIDEO, request_to_payload(video)) == video

    image = image_request(channel="pro")
    assert request_to_payload(image)["channel"] == "pro"
    assert request_from_payload(KIND_IMAGE, request_to_payload(image)) == image


def test_image_model_and_channel_are_optional_on_the_wire_but_video_model_is_not() -> None:
    """图片两者都在受理阶段填；视频照上游，模型必填。"""

    assert image_request().model is None
    assert image_request().channel is None
    with pytest.raises(ValueError):
        VideoGenerationIn(prompt="猫")  # type: ignore[call-arg]


def test_bad_channel_is_rejected_but_historical_model_names_remain_readable() -> None:
    """渠道为封闭枚举；模型选择策略在受理时校验，不妨碍读取历史模型名。"""

    with pytest.raises(ValueError):
        image_request(channel="prod")
    assert video_request(model="随便一个对方认的名字").model is not None
