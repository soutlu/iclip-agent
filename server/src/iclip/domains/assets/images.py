"""图片尺寸校验。直传校验客户端声明的宽高，转存从文件头读取真实尺寸；宽高不写入素材记录。"""

from __future__ import annotations

import io

from PIL import Image, UnidentifiedImageError

from iclip.common.errors import ValidationFailed
from iclip.domains.assets.models import MAX_LONG_EDGE_PIXELS, MIN_SHORT_EDGE_PIXELS


def check_dimensions(width: int, height: int) -> None:
    """按短边和长边校验尺寸，超限抛 ValidationFailed。"""

    if min(width, height) < MIN_SHORT_EDGE_PIXELS:
        raise ValidationFailed(
            f"{width}×{height} 的短边不到 {MIN_SHORT_EDGE_PIXELS}px，这张图太小了"
        )
    if max(width, height) > MAX_LONG_EDGE_PIXELS:
        raise ValidationFailed(
            f"{width}×{height} 的长边超过 {MAX_LONG_EDGE_PIXELS}px，先缩一下再传"
        )


def check_image_bytes(content: bytes) -> None:
    """从文件头读取尺寸并校验，不解码完整像素。"""

    try:
        with Image.open(io.BytesIO(content)) as image:
            width, height = image.size
    except (UnidentifiedImageError, OSError) as exc:
        raise ValidationFailed("这段字节读不出图片尺寸，不像是一张图") from exc
    check_dimensions(width, height)


__all__ = ["check_dimensions", "check_image_bytes"]
