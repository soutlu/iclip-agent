"""结构化镜头组的入参、文档构造与文件校验；不访问存储或外部服务。"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

import pytest
from pydantic import ValidationError
from pydantic_ai import ModelRetry

from iclip.capabilities.shot_document import (
    AspectError,
    VideoShotRequest,
    build_video_shots_document,
    parse_aspect,
    validate_shots_document,
    validate_video_shot_requests,
)
from tests.helpers.shot_document import shots_document

FIRST_IMAGE = "https://cdn.test/first.jpg"
SECOND_IMAGE = "https://cdn.test/second.jpg"


def item(timestamps: Any = None, *, prompt: str = "她走进门厅 @Image1。") -> dict[str, Any]:
    return {"timestamps": [0, 8] if timestamps is None else timestamps, "prompt": prompt}


def prompt_value(
    *, global_settings: str = "人物与场景保持一致。", timeline: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    return {
        "global_settings": global_settings,
        "timeline": [item()] if timeline is None else timeline,
    }


def request(**overrides: Any) -> VideoShotRequest:
    payload = {
        "index": 1,
        "prompt": prompt_value(),
        "seconds": 8,
        "image_urls": [FIRST_IMAGE],
    }
    return VideoShotRequest.model_validate_json(json.dumps(payload | overrides, ensure_ascii=False))


def test_accepts_decimal_timestamps_and_preserves_text_and_picture_order() -> None:
    settings = "  人物与场景保持一致。\n剪辑形式：硬切。\n"
    opening = "\n 开场，她说 {Look here!} @Image2，<脚步声>。  "
    ending = " 硬切，镜头推进 @Image1。\n"
    shot = request(
        prompt=prompt_value(
            global_settings=settings,
            timeline=[item([0, 1.2], prompt=opening), item([1.2, 8], prompt=ending)],
        ),
        image_urls=[SECOND_IMAGE, FIRST_IMAGE],
    )
    before = shot.model_dump()

    validate_video_shot_requests([shot])

    assert shot.prompt.global_settings == settings
    assert [entry.prompt for entry in shot.prompt.timeline] == [opening, ending]
    assert [entry.timestamps for entry in shot.prompt.timeline] == [[0, 1.2], [1.2, 8]]
    assert shot.image_urls == [SECOND_IMAGE, FIRST_IMAGE]
    assert shot.model_dump() == before


@pytest.mark.parametrize(
    "prompt",
    [
        pytest.param("原有字符串描述", id="string-prompt"),
        pytest.param(json.dumps({"global_settings": "设定"}), id="json-encoded-but-incomplete"),
        pytest.param({}, id="missing-prompt-fields"),
        pytest.param({"global_settings": "设定"}, id="missing-timeline"),
        pytest.param({"timeline": [item()]}, id="missing-global-settings"),
        pytest.param(prompt_value() | {"segments": []}, id="unknown-prompt-field"),
        pytest.param(prompt_value(timeline=[]), id="empty-timeline"),
        pytest.param(prompt_value(timeline=[{}]), id="missing-item-fields"),
        pytest.param(prompt_value(timeline=[{"prompt": "正文"}]), id="missing-timestamps"),
        pytest.param(prompt_value(timeline=[{"timestamps": [0, 8]}]), id="missing-item-prompt"),
        pytest.param(prompt_value(timeline=[item() | {"index": 1}]), id="unknown-timeline-field"),
    ],
)
def test_rejects_invalid_prompt_structure(prompt: Any) -> None:
    with pytest.raises(ValidationError):
        request(prompt=prompt)


def test_json_encoded_prompt_is_parsed_into_the_same_structure() -> None:
    """模型把 prompt 整体序列化成字符串时先还原，结果与直接传对象一致。"""

    encoded = request(prompt=json.dumps(prompt_value(), ensure_ascii=False))

    assert encoded.prompt == request(prompt=prompt_value()).prompt


@pytest.mark.parametrize("timestamps", [[], [0], [0, 4, 8]], ids=["empty", "one", "three"])
def test_timestamps_require_exactly_two_values(timestamps: list[int]) -> None:
    with pytest.raises(ValidationError):
        request(prompt=prompt_value(timeline=[item(timestamps)]))


@pytest.mark.parametrize(
    "timestamps",
    [
        pytest.param(["0", 8], id="string-start"),
        pytest.param([0, "8"], id="string-end"),
        pytest.param([False, 8], id="boolean-start"),
        pytest.param([0, True], id="boolean-end"),
        pytest.param([0, None], id="null-end"),
        pytest.param([-0.1, 8], id="negative-start"),
        pytest.param([0, -0.1], id="negative-end"),
        pytest.param([0, float("nan")], id="nan"),
        pytest.param([0, float("inf")], id="infinity"),
        pytest.param([float("-inf"), 8], id="negative-infinity"),
    ],
)
def test_timestamps_reject_non_numeric_non_finite_and_negative_values(
    timestamps: list[Any],
) -> None:
    with pytest.raises(ValidationError):
        request(prompt=prompt_value(timeline=[item(timestamps)]))


@pytest.mark.parametrize(
    ("prompt", "message"),
    [
        (prompt_value(global_settings=" \n\t"), "global_settings"),
        (prompt_value(timeline=[item(prompt=" \n\t")]), "第 1 镜"),
    ],
    ids=["blank-settings", "blank-item-prompt"],
)
def test_rejects_blank_text(prompt: dict[str, Any], message: str) -> None:
    with pytest.raises(ModelRetry, match=message):
        validate_video_shot_requests([request(prompt=prompt)])


@pytest.mark.parametrize(
    ("timeline", "message"),
    [
        pytest.param([item([0, 0])], "结束时间", id="zero-duration"),
        pytest.param([item([3, 2])], "结束时间", id="reversed-interval"),
        pytest.param([item([0.1, 8])], "从 0 开始", id="nonzero-origin"),
        pytest.param([item([0, 4]), item([3.9, 8])], "不得重叠", id="overlap"),
        pytest.param([item([0, 2]), item([4, 6]), item([2, 4])], "先后顺序", id="out-of-order"),
    ],
)
def test_rejects_invalid_timeline_order(timeline: list[dict[str, Any]], message: str) -> None:
    with pytest.raises(ModelRetry, match=message):
        validate_video_shot_requests([request(prompt=prompt_value(timeline=timeline))])


def test_accepts_time_gaps_without_closing_them() -> None:
    shot = request(prompt=prompt_value(timeline=[item([0, 3]), item([4, 8])]))

    validate_video_shot_requests([shot])

    assert [entry.timestamps for entry in shot.prompt.timeline] == [[0, 3], [4, 8]]


@pytest.mark.parametrize("indexes", [[], [0], [2], [1, 1], [1, 3]])
def test_requires_nonempty_shots_numbered_from_one(indexes: list[int]) -> None:
    with pytest.raises(ModelRetry, match=r"shots|index"):
        validate_video_shot_requests([request(index=index) for index in indexes])


@pytest.mark.parametrize("seconds", [4, 30])
def test_accepts_group_duration_boundaries(seconds: int) -> None:
    shot = request(seconds=seconds, prompt=prompt_value(timeline=[item([0, seconds])]))

    validate_video_shot_requests([shot])


@pytest.mark.parametrize("seconds", [3, 31])
def test_rejects_out_of_range_group_duration(seconds: int) -> None:
    with pytest.raises(ModelRetry, match="4-30"):
        validate_video_shot_requests(
            [request(seconds=seconds, prompt=prompt_value(timeline=[item([0, seconds])]))]
        )


def test_group_duration_requires_integer_seconds() -> None:
    with pytest.raises(ValidationError):
        request(seconds=8.2)


@pytest.mark.parametrize("reference", ["@Image0", "@Image3"])
def test_rejects_references_outside_the_groups_image_list(reference: str) -> None:
    shot = request(
        prompt=prompt_value(timeline=[item(prompt=f"她展示产品 {reference}。")]),
        image_urls=[FIRST_IMAGE, SECOND_IMAGE],
    )

    with pytest.raises(ModelRetry, match=reference):
        validate_video_shot_requests([shot])


def test_global_settings_references_use_the_groups_image_list() -> None:
    settings = " 参考图 @Image2。\n"
    shot = request(prompt=prompt_value(global_settings=settings), image_urls=[FIRST_IMAGE])

    with pytest.raises(ModelRetry, match=r"global_settings.*@Image2"):
        validate_video_shot_requests([shot])

    assert shot.prompt.global_settings == settings


@pytest.mark.parametrize("text", ["她展示产品 @Image1，再转身 @Image1。", "她转身离开。"])
def test_accepts_repeated_references_and_unreferenced_images(text: str) -> None:
    validate_video_shot_requests(
        [
            request(
                prompt=prompt_value(timeline=[item(prompt=text)]),
                image_urls=[FIRST_IMAGE, SECOND_IMAGE],
            )
        ]
    )


def test_each_group_restarts_its_timeline_and_image_numbers() -> None:
    first = request(
        prompt=prompt_value(timeline=[item(prompt="她展示产品 @Image2。")]),
        image_urls=[FIRST_IMAGE, SECOND_IMAGE],
    )
    second = request(index=2, image_urls=[SECOND_IMAGE])

    validate_video_shot_requests([first, second])


def test_image_reference_cannot_borrow_another_groups_image_count() -> None:
    first = request(image_urls=[FIRST_IMAGE, SECOND_IMAGE])
    second = request(
        index=2,
        prompt=prompt_value(timeline=[item(prompt="她展示产品 @Image2。")]),
        image_urls=[SECOND_IMAGE],
    )

    with pytest.raises(ModelRetry, match=r"镜头组 2.*@Image2"):
        validate_video_shot_requests([first, second])


@pytest.mark.parametrize("image_urls", [[""], [FIRST_IMAGE, " \n\t"]])
def test_rejects_blank_image_addresses(image_urls: list[str]) -> None:
    with pytest.raises(ModelRetry, match="image_urls"):
        validate_video_shot_requests([request(image_urls=image_urls)])


def test_accepts_an_image_free_group_without_references() -> None:
    shot = request(prompt=prompt_value(timeline=[item(prompt="  她走进门厅。\n")]), image_urls=[])
    before = shot.model_dump()

    validate_video_shot_requests([shot])

    assert shot.model_dump() == before


@pytest.mark.parametrize(
    ("prompt", "message"),
    [
        pytest.param(
            prompt_value(
                global_settings="人物参照 @Image1。", timeline=[item(prompt="她走进门厅。")]
            ),
            r"global_settings.*@Image1",
            id="global-settings",
        ),
        pytest.param(prompt_value(), r"第 1 镜.*@Image1", id="timeline"),
    ],
)
def test_image_free_group_rejects_references(prompt: dict[str, Any], message: str) -> None:
    with pytest.raises(ModelRetry, match=message):
        validate_video_shot_requests([request(prompt=prompt, image_urls=[])])


def test_document_only_adds_image_indexes_in_first_appearance_order_per_group() -> None:
    first = request(
        prompt=prompt_value(
            global_settings="  固定人物与场景。\n",
            timeline=[
                item([0, 1.2], prompt=" 开场 @Image2，抬手 @Image1，再转身 @Image2。\n"),
                item([2.1, 8.3], prompt=" 硬切，镜头移向窗外。\n"),
            ],
        ),
        image_urls=[SECOND_IMAGE, FIRST_IMAGE],
    )
    second = request(index=2, image_urls=[FIRST_IMAGE])
    requests = [first, second]
    before = [shot.model_dump(mode="json") for shot in requests]

    document = build_video_shots_document("9:16", requests)

    expected = [shot.model_dump(mode="json") for shot in requests]
    expected[0]["prompt"]["timeline"][0]["image_indexes"] = [2, 1]
    expected[0]["prompt"]["timeline"][1]["image_indexes"] = []
    expected[1]["prompt"]["timeline"][0]["image_indexes"] = [1]
    assert document.model_dump(mode="json") == {"aspect_ratio": "9:16", "shots": expected}
    assert [shot.model_dump(mode="json") for shot in requests] == before
    validate_shots_document(document.model_dump_json())


def test_document_preserves_decimal_timestamp_values_in_json() -> None:
    payload = json.dumps(
        {
            "index": 1,
            "prompt": prompt_value(
                timeline=[item([0, 1.23456789]), item([1.73456789, 3.20000001])]
            ),
            "seconds": 8,
            "image_urls": [FIRST_IMAGE],
        }
    )
    original = json.loads(payload, parse_float=Decimal)
    shot = VideoShotRequest.model_validate_json(payload)

    document = build_video_shots_document("9:16", [shot])

    persisted = json.loads(document.model_dump_json(), parse_float=Decimal)
    assert [entry["timestamps"] for entry in persisted["shots"][0]["prompt"]["timeline"]] == [
        entry["timestamps"] for entry in original["prompt"]["timeline"]
    ]
    assert persisted["shots"][0]["seconds"] == 8


def file_document(*, item_overrides: dict[str, Any] | None = None) -> str:
    timeline_item = {
        "timestamps": [0, 8],
        "prompt": "她抬手 @Image2，转身 @Image1，再回头 @Image2。",
        "image_indexes": [2, 1],
    }
    return json.dumps(
        {
            "aspect_ratio": "9:16",
            "shots": [
                {
                    "index": 1,
                    "prompt": {
                        "global_settings": "人物与场景保持一致。",
                        "timeline": [timeline_item | (item_overrides or {})],
                    },
                    "seconds": 8,
                    "image_urls": [FIRST_IMAGE, SECOND_IMAGE],
                }
            ],
        },
        ensure_ascii=False,
    )


@pytest.mark.parametrize(
    "indexes",
    [
        pytest.param([], id="all-references-missing"),
        pytest.param([2], id="reference-missing"),
        pytest.param([1, 2], id="wrong-order"),
        pytest.param([2, 1, 2], id="duplicate"),
        pytest.param([2, 1, 3], id="extra-reference"),
        pytest.param([0, 2, 1], id="zero-index"),
        pytest.param(["2", 1], id="string-index"),
        pytest.param([2, True], id="boolean-index"),
    ],
)
def test_file_image_indexes_must_exactly_match_prompt_references(indexes: list[Any]) -> None:
    with pytest.raises(ValueError, match="image_indexes"):
        validate_shots_document(file_document(item_overrides={"image_indexes": indexes}))


def test_file_requires_image_indexes_on_every_timeline_item() -> None:
    document = json.loads(file_document())
    del document["shots"][0]["prompt"]["timeline"][0]["image_indexes"]

    with pytest.raises(ValueError, match="image_indexes"):
        validate_shots_document(json.dumps(document, ensure_ascii=False))


@pytest.mark.parametrize("image_urls", [[], [FIRST_IMAGE, SECOND_IMAGE]])
def test_file_allows_empty_image_indexes_when_the_prompt_has_no_references(
    image_urls: list[str],
) -> None:
    document = json.loads(
        file_document(item_overrides={"prompt": "她走出门厅。", "image_indexes": []})
    )
    document["shots"][0]["image_urls"] = image_urls

    validate_shots_document(json.dumps(document, ensure_ascii=False))


def test_file_rejects_camel_case_document_fields() -> None:
    document = json.loads(file_document())
    document["aspectRatio"] = document.pop("aspect_ratio")
    shot = document["shots"][0]
    shot["imageUrls"] = shot.pop("image_urls")

    with pytest.raises(ValueError, match=r"aspect_ratio|aspectRatio"):
        validate_shots_document(json.dumps(document, ensure_ascii=False))


@pytest.mark.parametrize(
    "value", ["9", "9:16:1", "a:b", "0:16", "9:0", "-9:16", ""], ids=lambda v: v or "empty"
)
def test_aspect_rejects_broken_text(value: str) -> None:
    with pytest.raises(AspectError):
        parse_aspect(value)


def test_aspect_parses() -> None:
    assert parse_aspect("16:9") == pytest.approx(16 / 9)


def test_written_back_table_accepts_the_current_document_format() -> None:

    validate_shots_document(shots_document())


def test_written_back_table_does_not_ask_where_the_urls_came_from() -> None:
    """素材来源校验约束模型生成；用户写回仅校验文档形状。"""

    validate_shots_document(
        shots_document(
            shots=[
                json.loads(shots_document())["shots"][0]
                | {"image_urls": ["https://别处.test/x.jpg"]}
            ]
        )
    )


@pytest.mark.parametrize(
    ("content", "message"),
    [
        ("{不是 json", "不是合法的 JSON"),
        ("[]", "根必须是一个对象"),
        (json.dumps({"aspect_ratio": "9:16"}), "shots"),
        (shots_document(aspect_ratio="竖版"), "画幅"),
        (json.dumps({"aspect_ratio": "9:16", "shots": [{"index": 1}]}), "prompt"),
        (
            shots_document(shots=[json.loads(shots_document())["shots"][0] | {"index": 2}]),
            "连续编号",
        ),
        (
            shots_document(shots=[json.loads(shots_document())["shots"][0] | {"seconds": 31}]),
            "4-30",
        ),
        (
            shots_document(shots=[json.loads(shots_document())["shots"][0] | {"image_urls": []}]),
            "@Image1",
        ),
        (
            shots_document(
                shots=[json.loads(shots_document())["shots"][0] | {"image_urls": ["  "]}]
            ),
            "空地址",
        ),
        (
            shots_document(
                shots=[
                    json.loads(shots_document())["shots"][0]
                    | {
                        "prompt": {
                            "global_settings": "人物与门厅保持一致。",
                            "timeline": [
                                {
                                    "timestamps": [0, 8],
                                    "prompt": "她走进门厅 @Image2。",
                                    "image_indexes": [2],
                                }
                            ],
                        }
                    }
                ]
            ),
            "@Image2",
        ),
    ],
    ids=[
        "bad-json",
        "not-object",
        "no-shots",
        "bad-aspect",
        "bad-row",
        "index-gap",
        "seconds",
        "reference-without-images",
        "blank-url",
        "image-ref",
    ],
)
def test_written_back_table_is_rejected_with_the_reason(content: str, message: str) -> None:

    with pytest.raises(ValueError, match=message):
        validate_shots_document(content)
