"""验证 ffmpeg 子进程封装对部署缺失的翻译，以及远程裁剪的地址门槛。"""

from __future__ import annotations

from pathlib import Path

import pytest

from iclip.platform.media.ffmpeg import MediaError, cut_copy_url, run


async def test_a_missing_binary_is_reported_as_a_media_error() -> None:
    """二进制不在 PATH 上要翻成 MediaError，否则裸 FileNotFoundError 会逃出队列。"""

    with pytest.raises(MediaError, match="PATH 上找不到 /nonexistent/ffmpeg"):
        await run(["/nonexistent/ffmpeg", "-version"], timeout=5.0)


@pytest.mark.parametrize("url", ["file:///etc/passwd", "http://"])
async def test_remote_cut_refuses_a_non_http_address_before_spawning(
    url: str, tmp_path: Path
) -> None:
    with pytest.raises(MediaError, match="不是 http"):
        await cut_copy_url(url, start=0, end=1, dest=tmp_path / "out.mp4")
