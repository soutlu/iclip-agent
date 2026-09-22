"""验证 ffmpeg 子进程封装对部署缺失的翻译。"""

from __future__ import annotations

import pytest

from iclip.platform.media.ffmpeg import MediaError, run


async def test_a_missing_binary_is_reported_as_a_media_error() -> None:
    """二进制不在 PATH 上要翻成 MediaError，否则裸 FileNotFoundError 会逃出队列。"""

    with pytest.raises(MediaError, match="PATH 上找不到 /nonexistent/ffmpeg"):
        await run(["/nonexistent/ffmpeg", "-version"], timeout=5.0)
