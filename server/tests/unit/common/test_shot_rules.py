"""镜头组规则：出片请求（generation）与分镜文件（shot_document）对同一组样本给出同一个结论。

两边都调 common/shot_rules、各写各的文案；每个样本同时对照期望值，任一边绕开或接错规则都会红。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import pytest
from pydantic import ValidationError

from iclip.capabilities.shot_document import ShotDocumentError, validate_shots_document
from iclip.common.shot_rules import MAX_REFERENCE_IMAGES, image_indexes_of
from iclip.domains.generation.schemas import VideoGenerationIn

SETTINGS = "人物与门厅保持一致。"
WITH_IMAGE = "全景，她走进门厅 @Image1。"
PLAIN = "近景，她停下。"


@dataclass(frozen=True)
class Sample:
    """一组镜头：逐镜 ``(起, 止, 正文, image_indexes)``，外加全局设定与本组几张图。"""

    timeline: tuple[tuple[float, float, str, list[int]], ...]
    images: int = 1
    global_settings: str = SETTINGS

    def prompt(self) -> dict[str, Any]:
        return {
            "global_settings": self.global_settings,
            "timeline": [
                {"timestamps": [start, end], "prompt": text, "image_indexes": indexes}
                for start, end, text, indexes in self.timeline
            ],
        }

    def urls(self) -> list[str]:
        return [f"https://cdn.test/frames/{n}.jpg" for n in range(1, self.images + 1)]


def generation_accepts(sample: Sample) -> bool:
    try:
        VideoGenerationIn.model_validate(
            {"model": "seedance", "shot": sample.prompt(), "reference_image_urls": sample.urls()}
        )
    except ValidationError:
        return False
    return True


def shot_document_accepts(sample: Sample) -> bool:
    row = {"index": 1, "prompt": sample.prompt(), "seconds": 8, "image_urls": sample.urls()}
    try:
        validate_shots_document(
            json.dumps({"aspect_ratio": "9:16", "shots": [row]}, ensure_ascii=False)
        )
    except ShotDocumentError:
        return False
    return True


@pytest.mark.parametrize(
    ("sample", "expected"),
    [
        pytest.param(Sample(((0, 3, WITH_IMAGE, [1]), (3, 8, PLAIN, []))), True, id="首尾相接"),
        pytest.param(Sample(((0, 1.2, WITH_IMAGE, [1]), (1.2, 8, PLAIN, []))), True, id="小数秒"),
        pytest.param(Sample(((0, 3, WITH_IMAGE, [1]), (5, 8, PLAIN, []))), True, id="中间留空档"),
        pytest.param(
            Sample(((0, 3, WITH_IMAGE, [1]), (5, 5, PLAIN, []))), False, id="结束不晚于开始"
        ),
        pytest.param(Sample(((0, 3, WITH_IMAGE, [1]), (5, 4, PLAIN, []))), False, id="起止倒置"),
        pytest.param(Sample(((1, 8, WITH_IMAGE, [1]),)), False, id="第一镜不从0起"),
        pytest.param(
            Sample(((0, 5, WITH_IMAGE, [1]), (4, 8, PLAIN, []))), False, id="与上一镜重叠"
        ),
        pytest.param(Sample(((0, 8, "看 @Image3。", [3]),), images=2), False, id="正文引用越界"),
        pytest.param(
            Sample(((0, 8, PLAIN, []),), global_settings="沿用 @Image2 的光线。"),
            False,
            id="全局设定引用越界",
        ),
        pytest.param(
            Sample(((0, 8, PLAIN, []),), global_settings="沿用 @Image0 的光线。"),
            False,
            id="引用0号",
        ),
        pytest.param(
            Sample(((0, 8, "先 @Image1 再 @Image2。", [2, 1]),), images=2),
            False,
            id="image_indexes与正文顺序不一致",
        ),
        pytest.param(Sample(((0, 8, PLAIN, []),), images=0), True, id="无图无引用"),
        pytest.param(Sample(((0, 8, WITH_IMAGE, [1]),), images=0), False, id="无图却引用"),
        pytest.param(
            Sample(
                ((0, 8, f"看 @Image{MAX_REFERENCE_IMAGES}。", [MAX_REFERENCE_IMAGES]),),
                images=MAX_REFERENCE_IMAGES,
            ),
            True,
            id="图数到上限",
        ),
        pytest.param(
            Sample(((0, 8, WITH_IMAGE, [1]),), images=MAX_REFERENCE_IMAGES + 1),
            False,
            id="图数超上限",
        ),
    ],
)
def test_generation_and_shot_document_reach_the_same_verdict(
    sample: Sample, expected: bool
) -> None:
    assert {
        "generation": generation_accepts(sample),
        "shot_document": shot_document_accepts(sample),
    } == {"generation": expected, "shot_document": expected}


def test_image_indexes_follow_first_appearance_and_dedupe() -> None:
    assert image_indexes_of("看 @Image2，再看 @Image1，回到 @Image2；@Image02 也是 2。") == [2, 1]
    assert image_indexes_of("没有引用。") == []
