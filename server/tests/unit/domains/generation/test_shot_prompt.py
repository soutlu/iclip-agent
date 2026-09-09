"""拼装规则的字面检查。

前端「复制完整提示词」照同一规则显示，所以第一个期望串与 web 的 storyboard.api 单测一字不差；
两边任何一边改了拼法，这里就得跟着改。"""

from __future__ import annotations

from typing import Any

import pytest

from iclip.domains.generation.schemas import VideoShotIn
from iclip.domains.generation.shot_prompt import (
    format_seconds,
    format_shot_prompt,
    image_indexes_of,
)
from tests.helpers.generation import SHOT_PROMPT, video_shot


def shot_of(global_settings: str, *timeline: dict[str, Any]) -> VideoShotIn:
    return VideoShotIn.model_validate(
        {"global_settings": global_settings, "timeline": list(timeline)}
    )


def test_single_shot_matches_the_frontend_fixture() -> None:
    assert format_shot_prompt(VideoShotIn.model_validate(video_shot())) == SHOT_PROMPT


def test_timestamps_are_printed_as_given_including_gaps_and_decimals() -> None:
    """起止照分镜文件里的写，镜头之间留的空档也照实保留，不改成首尾相接。"""

    shot = shot_of(
        "设定。",
        {"timestamps": [0, 3.5], "prompt": "一。", "image_indexes": []},
        {"timestamps": [4.25, 8.5], "prompt": "二。", "image_indexes": []},
        {"timestamps": [8.5, 9], "prompt": "三。", "image_indexes": []},
    )
    assert format_shot_prompt(shot) == (
        "设定。\n\n"
        "[0–3.5秒｜镜头1] 一。\n"
        "[4.25–8.5秒｜镜头2] 二。\n"
        "[8.5–9秒｜镜头3] 三。\n"
        "不要生成字幕，不要生成背景音乐。"
    )


def test_whitespace_inside_the_texts_is_kept() -> None:
    shot = shot_of(
        "  设定。\n",
        {"timestamps": [0, 2.0], "prompt": "  原文 @Image02。\n", "image_indexes": [2]},
    )
    assert format_shot_prompt(shot) == (
        "  设定。\n\n\n[0–2秒｜镜头1]   原文 @Image02。\n\n不要生成字幕，不要生成背景音乐。"
    )


@pytest.mark.parametrize(
    ("value", "text"),
    [(0, "0"), (4.0, "4"), (3.5, "3.5"), (8.25, "8.25"), (1.0004, "1"), (2.0006, "2.001")],
)
def test_format_seconds(value: float, text: str) -> None:
    assert format_seconds(value) == text


def test_image_indexes_follow_first_appearance_and_dedupe() -> None:
    assert image_indexes_of("看 @Image2，再看 @Image1，回到 @Image2；@Image02 也是 2。") == [2, 1]
    assert image_indexes_of("没有引用。") == []
