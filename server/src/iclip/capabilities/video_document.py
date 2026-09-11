"""参考视频拆解文档在工作区里的位置。"""

from __future__ import annotations

import hashlib
import re
from typing import Final

_UNSAFE_STEM = re.compile(r"[^A-Za-z0-9_-]+")
_STEM_CHARS: Final = 40
_DOC_DIR: Final = "video"


def video_doc_path(video_url: str) -> str:
    """由视频 URL 派生稳定文档路径，哈希后缀避免同名视频冲突。"""

    stem = _UNSAFE_STEM.sub("-", video_url.rsplit("/", 1)[-1].rsplit(".", 1)[0]).strip("-")
    digest = hashlib.sha256(video_url.encode("utf-8")).hexdigest()[:8]
    return f"{_DOC_DIR}/{(stem[:_STEM_CHARS] or 'video')}-{digest}.md"


__all__ = ["video_doc_path"]
