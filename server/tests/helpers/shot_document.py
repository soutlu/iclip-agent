"""镜头组 prompt 表的测试样例：一组镜头的工具入参与写回文件。"""

from __future__ import annotations

import json
from typing import Any

from iclip.capabilities.shot_document import VideoShotRequest

FRAME_URL = "https://cdn.test/frames/s1-1.jpg"
OTHER_FRAME_URL = "https://cdn.test/frames/s2-1.jpg"


def one_shot(**overrides: Any) -> VideoShotRequest:
    fields: dict[str, Any] = {
        "index": 1,
        "prompt": {
            "global_settings": "人物与门厅保持一致。",
            "timeline": [
                {"timestamps": [0, 8], "prompt": "全景，平视，固定，她走进门厅 @Image1。"}
            ],
        },
        "seconds": 8,
        "image_urls": [FRAME_URL],
    }
    return VideoShotRequest(**{**fields, **overrides})


def shots_document(**overrides: Any) -> str:
    """工作区文件校验入口接受的有效镜头组 prompt 表。"""

    row: dict[str, Any] = {
        "index": 1,
        "prompt": {
            "global_settings": "人物与门厅保持一致。",
            "timeline": [
                {
                    "timestamps": [0, 8],
                    "prompt": "全景，平视，固定，她走进门厅 @Image1。",
                    "image_indexes": [1],
                }
            ],
        },
        "seconds": 8,
        "image_urls": [FRAME_URL],
    }
    document: dict[str, Any] = {"aspect_ratio": "9:16", "shots": [row]}
    return json.dumps({**document, **overrides}, ensure_ascii=False)


__all__ = ["FRAME_URL", "OTHER_FRAME_URL", "one_shot", "shots_document"]
