"""验证 HTTP 请求与持久化负载共用校验定义，确保 worker 可读取已受理请求。"""

from __future__ import annotations

import uuid

import pytest

from iclip.common.errors import ValidationFailed
from iclip.domains.generation.schemas import (
    IMAGE_MAX_REFERENCES,
    KIND_IMAGE,
    KIND_VIDEO,
    MAX_METADATA_CHARS,
    OPERATION_COMPOSE,
    OPERATION_CUT,
    OPERATION_GENERATE,
    OPERATION_UPLOAD,
    ComposeSegment,
    ImageGenerationIn,
    VideoComposeRequest,
    VideoEditIn,
    VideoGenerationIn,
    request_from_payload,
    request_to_payload,
)
from tests.helpers.generation import (
    SHOT_IMAGE_URLS,
    SHOT_PROMPT,
    compose_request,
    image_request,
    video_request,
    video_shot,
)


def test_payload_round_trip_video() -> None:
    original = video_request(
        reference_image_urls=["https://example.test/a.png"],
        reference_audio_urls=["https://example.test/a.mp3"],
        resolution="1080p",
        provider_options={"output_format": "mov"},
    )
    assert (
        request_from_payload(KIND_VIDEO, OPERATION_GENERATE, request_to_payload(original))
        == original
    )


@pytest.mark.parametrize("generate_audio", [True, False, None])
def test_video_audio_choice_survives_payload_round_trip(generate_audio: bool | None) -> None:
    original = video_request(generate_audio=generate_audio)

    payload = request_to_payload(original)

    assert payload["generate_audio"] is generate_audio
    assert request_from_payload(KIND_VIDEO, OPERATION_GENERATE, payload) == original


def test_payload_round_trip_image() -> None:
    original = image_request(resolution="2k", reference_image_urls=["https://example.test/ref.png"])
    assert (
        request_from_payload(KIND_IMAGE, OPERATION_GENERATE, request_to_payload(original))
        == original
    )


def test_stored_payload_keeps_each_kinds_own_field_names() -> None:
    """视频照上游 snake_case，图片是本系统的 camelCase；kind 与归属字段都不进 JSON。"""

    payload = request_to_payload(video_request())
    assert "kind" not in payload
    assert set(payload) == {
        "model",
        "prompt",
        "shot",
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
    }


def test_a_stored_request_reads_back_without_its_origin_columns() -> None:
    """归属字段落列不落 JSON，所以读回时看不到——校验不能建在这条路上。"""

    task_id = uuid.uuid4()
    coordinate = {"path": "video_shot.json", "shot": 1, "frame": 2}
    image = request_to_payload(image_request(metadata=coordinate, task_id=task_id))
    assert {"metadata", "taskId", "conversationId"}.isdisjoint(image)
    restored = request_from_payload(KIND_IMAGE, OPERATION_GENERATE, image)
    assert isinstance(restored, ImageGenerationIn)
    assert restored.metadata is None, "坐标落列，读回的请求里没有它"

    video = request_to_payload(
        video_request(conversation_id=uuid.uuid4(), task_id=task_id, metadata={"shot": 3})
    )
    assert {"conversation_id", "metadata", "task_id"}.isdisjoint(video)


def test_a_composite_round_trips_and_keeps_open_ends_open() -> None:
    """合成落库的是各段与对账名；取到结尾的段存成 null，读回仍是开放的。"""

    original = compose_request()
    payload = request_to_payload(original)

    assert payload["segments"][1] == {
        "url": "https://example.com/edited.mp4",
        "start": 0,
        "end": None,
    }
    assert payload["userName"] == "luke"
    assert request_from_payload(KIND_VIDEO, OPERATION_COMPOSE, payload) == original


def test_a_legacy_master_payload_reads_back_as_a_composite() -> None:
    """迁移前拼好的成片只存了各段，去掉 purpose 后原样读回，没有对账名。"""

    legacy = {
        "segments": [
            {"url": "https://example.com/base.mp4", "start": 0, "end": 4},
            {"url": "https://example.com/edited.mp4", "start": 0, "end": 4.3},
            {"url": "https://example.com/base.mp4", "start": 8, "end": 15},
        ]
    }

    restored = request_from_payload(KIND_VIDEO, OPERATION_COMPOSE, legacy)

    assert isinstance(restored, VideoComposeRequest)
    assert [segment.end for segment in restored.segments] == [4, 4.3, 15]
    assert restored.user_name is None


def test_the_stored_shape_is_chosen_by_kind_and_operation() -> None:
    """同是 video，调模型的读成上游请求，本地拼接的读成合成；对不上的组合直接拒。"""

    video = request_to_payload(video_request())
    assert isinstance(
        request_from_payload(KIND_VIDEO, OPERATION_GENERATE, video), VideoGenerationIn
    )
    with pytest.raises(ValidationFailed, match="形状不合法"):
        request_from_payload(KIND_VIDEO, OPERATION_COMPOSE, video)
    with pytest.raises(ValidationFailed, match="未知的生成类型"):
        request_from_payload(KIND_IMAGE, OPERATION_COMPOSE, request_to_payload(image_request()))
    with pytest.raises(ValidationFailed, match="未知的生成类型"):
        request_from_payload("clip", OPERATION_COMPOSE, request_to_payload(compose_request()))


@pytest.mark.parametrize(
    "segment",
    [
        {"url": "file:///etc/passwd", "start": 0, "end": 1},
        {"url": "https:///a.mp4", "start": 0},
        {"url": "https://example.com/a.mp4", "start": -1},
        {"url": "https://example.com/a.mp4", "start": 2, "end": 2},
    ],
    ids=["不是 http", "没有主机名", "起点为负", "结尾不晚于起点"],
)
def test_a_composite_segment_must_be_a_downloadable_forward_span(
    segment: dict[str, object],
) -> None:
    with pytest.raises(ValueError):
        ComposeSegment.model_validate(segment)


def test_an_edit_takes_a_forward_range_and_none_of_the_fields_the_server_fills() -> None:
    """编辑段只收区间与正文；参考视频由服务端切，原作由基底定，结构化镜头组不收。"""

    base = {
        "source_job_id": str(uuid.uuid4()),
        "range_start_ms": 1000,
        "range_end_ms": 4000,
        "model": "m",
        "prompt": "换成编织凉鞋",
    }
    assert VideoEditIn.model_validate(base).range_end_ms == 4000
    for flaw in (
        {"range_start_ms": -1},
        {"range_end_ms": 1000},
        {"reference_video_urls": ["https://example.com/ref.mp4"]},
        {"root_job_id": str(uuid.uuid4())},
        {"shot": video_shot()},
    ):
        with pytest.raises(ValueError):
            VideoEditIn.model_validate({**base, **flaw})


def test_shot_index_stays_its_own_field_and_never_enters_metadata_or_the_payload() -> None:
    """镜头组编号落记录自己的列：不折进 metadata、不进 request；metadata 里的 shot 不是镜号。"""

    numbered = video_request(shot_index=2, metadata={"frame": 1})
    assert (numbered.shot_index, numbered.metadata) == (2, {"frame": 1})
    assert "shot_index" not in request_to_payload(numbered)

    tagged = video_request(metadata={"shot": 3})
    assert (tagged.shot_index, tagged.metadata) == (None, {"shot": 3})
    # 镜头组从 1 数：0 与负数都不是镜头号，收下只会落一条读不出镜头组的记录。
    for invalid in (0, -1):
        with pytest.raises(ValueError, match="shot_index"):
            video_request(shot_index=invalid)


def test_metadata_is_bounded_but_otherwise_opaque() -> None:
    """服务端不读键：任意形状都收，只拦超长。"""

    assert image_request(metadata={"anything": {"nested": [1, 2]}}).metadata == {
        "anything": {"nested": [1, 2]}
    }
    with pytest.raises(ValueError, match="metadata"):
        video_request(metadata={"note": "x" * MAX_METADATA_CHARS})


def test_unknown_kind_is_rejected() -> None:
    with pytest.raises(ValidationFailed, match="未知的生成类型"):
        request_from_payload("audio", OPERATION_GENERATE, {"prompt": "x"})


@pytest.mark.parametrize(
    ("kind", "operation"),
    [(KIND_IMAGE, OPERATION_CUT), (KIND_IMAGE, OPERATION_UPLOAD), (KIND_VIDEO, OPERATION_UPLOAD)],
)
def test_cuts_and_uploads_have_no_request(kind: str, operation: str) -> None:
    """切图与上传创建即完成，没有发给执行方的输入：读回 None，存着一份请求就是持久化坏了。"""

    assert request_to_payload(None) is None
    assert request_from_payload(kind, operation, None) is None
    with pytest.raises(ValidationFailed):
        request_from_payload(kind, operation, {"prompt": "x"})


def test_a_video_cut_is_not_a_record_we_know() -> None:
    with pytest.raises(ValidationFailed, match="未知的生成类型"):
        request_from_payload(KIND_VIDEO, OPERATION_CUT, None)


@pytest.mark.parametrize(
    ("kind", "operation"),
    [
        (KIND_VIDEO, OPERATION_GENERATE),
        (KIND_IMAGE, OPERATION_GENERATE),
        (KIND_VIDEO, OPERATION_COMPOSE),
    ],
)
def test_records_that_call_an_executor_must_have_a_request(kind: str, operation: str) -> None:
    with pytest.raises(ValidationFailed):
        request_from_payload(kind, operation, None)


# --- 结构化镜头组 shot ------------------------------------------------------------


def test_shot_is_assembled_into_the_prompt_and_both_are_stored() -> None:
    original = video_request(prompt=None, shot=video_shot(), reference_image_urls=SHOT_IMAGE_URLS)

    assert original.prompt == SHOT_PROMPT
    payload = request_to_payload(original)
    assert payload["prompt"] == SHOT_PROMPT
    assert payload["shot"]["timeline"][0]["image_indexes"] == [1, 2]
    assert request_from_payload(KIND_VIDEO, OPERATION_GENERATE, payload) == original, (
        "读回时两者都在且一致"
    )


def test_image_indexes_follow_the_text_in_first_appearance_order() -> None:
    item = {
        "timestamps": [0, 6],
        "prompt": "走向镜头 @Image2，停下 @Image1，回头 @Image2。",
        "image_indexes": [2, 1],
    }
    request = video_request(
        prompt=None, shot=video_shot(timeline=[item]), reference_image_urls=SHOT_IMAGE_URLS
    )

    assert request.shot is not None
    assert request.shot.timeline[0].image_indexes == [2, 1]
    with pytest.raises(ValueError, match="Field required"):
        video_request(
            prompt=None,
            shot=video_shot(timeline=[{"timestamps": [0, 6], "prompt": "看 @Image1。"}]),
            reference_image_urls=SHOT_IMAGE_URLS,
        )


def test_a_prompt_identical_to_the_assembly_is_accepted_alongside_the_shot() -> None:
    request = video_request(
        prompt=SHOT_PROMPT, shot=video_shot(), reference_image_urls=SHOT_IMAGE_URLS
    )
    assert request.prompt == SHOT_PROMPT


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"prompt": None}, "至少传一个"),
        (
            {
                "prompt": "自己写的正文",
                "shot": video_shot(),
                "reference_image_urls": SHOT_IMAGE_URLS,
            },
            "不一致，二者只传一个",
        ),
        (
            {"prompt": None, "shot": video_shot(), "reference_image_urls": SHOT_IMAGE_URLS[:1]},
            "@Image2",
        ),
        ({"prompt": None, "shot": video_shot()}, "只有 0 张"),
        (
            {
                "prompt": None,
                "shot": video_shot(global_settings="开场看 @Image3。"),
                "reference_image_urls": SHOT_IMAGE_URLS,
            },
            "global_settings 引用了 @Image3",
        ),
        (
            {
                "prompt": None,
                "shot": video_shot(
                    timeline=[
                        {"timestamps": [0, 6], "prompt": "看 @Image1。", "image_indexes": [2]}
                    ]
                ),
                "reference_image_urls": SHOT_IMAGE_URLS,
            },
            "image_indexes",
        ),
        ({"prompt": None, "shot": video_shot(timeline=[])}, "at least 1"),
        (
            {
                "prompt": None,
                "shot": video_shot(
                    timeline=[{"timestamps": [3, 3], "prompt": "一。", "image_indexes": []}]
                ),
            },
            "结束必须晚于开始",
        ),
        (
            {
                "prompt": None,
                "shot": video_shot(
                    timeline=[{"timestamps": [1, 4], "prompt": "一。", "image_indexes": []}]
                ),
            },
            "必须从 0 开始",
        ),
        (
            {
                "prompt": None,
                "shot": video_shot(
                    timeline=[
                        {"timestamps": [0, 4], "prompt": "一。", "image_indexes": []},
                        {"timestamps": [3.5, 7], "prompt": "二。", "image_indexes": []},
                    ]
                ),
            },
            "早于上一镜的结束 4 秒",
        ),
        (
            {
                "prompt": None,
                "shot": video_shot(
                    timeline=[{"timestamps": [-1, 4], "prompt": "一。", "image_indexes": []}]
                ),
            },
            "greater than or equal to 0",
        ),
        (
            {
                "prompt": None,
                "shot": video_shot(
                    timeline=[{"timestamps": [0, 2], "prompt": " \n", "image_indexes": []}]
                ),
            },
            "空白",
        ),
        ({"prompt": None, "shot": video_shot(global_settings="  ")}, "空白"),
        (
            {
                "prompt": None,
                "shot": video_shot(
                    timeline=[{"timestamps": [0, 2], "prompt": "长" * 3990, "image_indexes": []}]
                ),
            },
            "超过 4000 字上限",
        ),
        (
            {"prompt": None, "shot": {"global_settings": "设定。", "timeline": [], "index": 1}},
            "extra",
        ),
    ],
)
def test_shot_is_rejected_when_it_does_not_hold_together(
    overrides: dict[str, object], message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        video_request(**overrides)


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


@pytest.mark.parametrize("url", ["file:///etc/passwd", "http://"])
def test_non_http_reference_url_is_rejected(url: str) -> None:
    """参考 URL 由供应商下载，只接受带主机名的 HTTP(S)，避免 file:// 等协议访问本地文件。"""

    with pytest.raises(ValueError):
        VideoGenerationIn(
            model="moyu-seedance-2-5",
            prompt="猫",
            reference_video_urls=[url],
        )


@pytest.mark.parametrize(
    "damaged",
    [
        {"prompt": "猫"},
        {"model": "m", "seconds": 5},
        {"model": "m", "prompt": "猫", "seconds": "五秒"},
        {"model": "m", "prompt": "猫", "aspectRatio": "16:9"},
    ],
)
def test_damaged_persisted_shape_fails_loudly(damaged: dict[str, object]) -> None:

    with pytest.raises(ValidationFailed, match="形状不合法"):
        request_from_payload(KIND_VIDEO, OPERATION_GENERATE, damaged)


def test_model_and_channel_are_part_of_the_stored_request() -> None:
    """持久化实际模型与渠道：视频模型为请求参数，图片按 model 选家并通过 dev/pro 选择渠道。"""

    video = video_request(model="mmt-seedance-3-0")
    assert request_to_payload(video)["model"] == "mmt-seedance-3-0"
    assert request_from_payload(KIND_VIDEO, OPERATION_GENERATE, request_to_payload(video)) == video

    image = image_request(channel="pro")
    assert request_to_payload(image)["channel"] == "pro"
    assert request_from_payload(KIND_IMAGE, OPERATION_GENERATE, request_to_payload(image)) == image


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
