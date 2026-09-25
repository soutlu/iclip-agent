"""拼装规则的字面检查，以及反拆与拼装互为逆。

前端「复制完整提示词」照同一规则显示，所以第一个期望串与 web 的 storyboard.api 单测一字不差；
两边任何一边改了拼法，这里就得跟着改。"""

from __future__ import annotations

from typing import Any

import pytest

from iclip.common.shot_prompt import (
    ShotCut,
    ShotScript,
    format_seconds,
    format_shot_prompt,
    parse_shot_prompt,
)
from iclip.domains.generation.schemas import VideoShotIn
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


MULTI_CUT = (
    "设定第一行。\n设定第二行。\n\n"
    "[0–3.5秒｜镜头1] 走近 @Image2，再看 @Image1。\n"
    "[4.25–8.5秒｜镜头2] 转身。\n第二行接着写。\n"
    "[8.5–9秒｜镜头3] 收尾。\n"
    "不要生成字幕，不要生成背景音乐。"
)


@pytest.mark.parametrize(
    "text",
    [
        SHOT_PROMPT,
        MULTI_CUT,
        "  设定。\n\n\n[0–2秒｜镜头1]   原文 @Image02。\n\n不要生成字幕，不要生成背景音乐。",
    ],
)
def test_parsing_then_formatting_gives_back_the_same_text(text: str) -> None:
    parsed = parse_shot_prompt(text)

    assert parsed is not None
    assert format_shot_prompt(parsed) == text


def test_parsing_recovers_the_structure() -> None:
    assert parse_shot_prompt(MULTI_CUT) == ShotScript(
        global_settings="设定第一行。\n设定第二行。",
        timeline=(
            ShotCut(
                timestamps=(0, 3.5), prompt="走近 @Image2，再看 @Image1。", image_indexes=(2, 1)
            ),
            ShotCut(timestamps=(4.25, 8.5), prompt="转身。\n第二行接着写。", image_indexes=()),
            ShotCut(timestamps=(8.5, 9), prompt="收尾。", image_indexes=()),
        ),
    )


def test_formatted_request_shot_parses_back_to_the_same_timeline() -> None:
    shot = VideoShotIn.model_validate(video_shot())

    parsed = parse_shot_prompt(format_shot_prompt(shot))

    assert parsed is not None
    assert parsed.global_settings == shot.global_settings
    assert [(cut.timestamps, cut.prompt, list(cut.image_indexes)) for cut in parsed.timeline] == [
        (item.timestamps, item.prompt, item.image_indexes) for item in shot.timeline
    ]


def test_the_old_layout_with_markers_on_their_own_line_still_parses() -> None:
    """2026-09-08 之前：约束行夹在全局设定里，标记独占一行，镜与镜之间空一行。"""

    text = (
        "人物保持一致。\n不要生成字幕，不要生成背景音乐。\n\n"
        "[0–2.5秒｜镜头1]\n模特走出门厅 @Image2。\n\n"
        "[2.5–6秒｜镜头2]\n转身看向鞋面 @Image1。"
    )

    parsed = parse_shot_prompt(text)

    assert parsed is not None
    assert parsed.global_settings.strip() == "人物保持一致。"
    assert [(cut.timestamps, cut.prompt.strip(), cut.image_indexes) for cut in parsed.timeline] == [
        ((0, 2.5), "模特走出门厅 @Image2。", (2,)),
        ((2.5, 6), "转身看向鞋面 @Image1。", (1,)),
    ]


@pytest.mark.parametrize(
    "text",
    [
        "模特走向镜头，停下微笑。",
        "设定。\n\n[1–3秒｜镜头1] 第一镜不从 0 起。",
        "设定。\n\n[0–3秒｜镜头1] 一。\n[2–4秒｜镜头2] 和上一镜交叠。",
        "设定。\n\n[0–0秒｜镜头1] 结束不晚于开始。",
        # 几组镜头拼在一段里，每组都从 0 起，时间线接不上
        "镜头组 1\n设定。\n\n[0–3秒｜镜头1] 一。\n\n镜头组 2\n设定。\n\n[0–4秒｜镜头1] 二。",
    ],
)
def test_text_that_is_not_a_shot_group_is_left_as_plain_text(text: str) -> None:
    assert parse_shot_prompt(text) is None
