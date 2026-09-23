"""参考视频拆解文档在工作区里的位置与镜头时间码的形状。"""

from __future__ import annotations

import hashlib
import re
from typing import Final

SHOT_TIMECODE_SHAPE: Final = "**[MM:SS.mmm-MM:SS.mmm]**"
"""拆解文档里镜头时间码的写法：拆解提示词照它要求，取帧解析器报错时照它提示。"""

_UNSAFE_STEM = re.compile(r"[^A-Za-z0-9_-]+")
_STEM_CHARS: Final = 40
_DOC_DIR: Final = "video"


def video_doc_path(video_url: str) -> str:
    """由视频 URL 派生稳定文档路径，哈希后缀避免同名视频冲突。"""

    stem = _UNSAFE_STEM.sub("-", video_url.rsplit("/", 1)[-1].rsplit(".", 1)[0]).strip("-")
    digest = hashlib.sha256(video_url.encode("utf-8")).hexdigest()[:8]
    return f"{_DOC_DIR}/{(stem[:_STEM_CHARS] or 'video')}-{digest}.md"


__all__ = ["SHOT_TIMECODE_SHAPE", "video_doc_path"]
