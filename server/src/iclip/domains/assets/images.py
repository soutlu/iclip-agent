"""图片尺寸这道闸。

两条进来的路，量法不同：

- **直传**信客户端报的宽高。字节从没经过我们的进程，要量就得先从桶里整份读回来；
  而账本里根本没有宽高列，报假了也污染不了任何落库的事实——最坏就是一张超范围的图
  混进库里。用一次 16MB 回读换这个，不值。
- **转存**字节就在手上，直接量。

这是本仓唯一需要位图库的第二处（另一处是预览板拼版）。
"""

from __future__ import annotations

import io

from PIL import Image, UnidentifiedImageError

from iclip.common.errors import ValidationFailed
from iclip.domains.assets.models import MAX_LONG_EDGE_PIXELS, MIN_SHORT_EDGE_PIXELS


def check_dimensions(width: int, height: int) -> None:
    """不在区间内就抛 ``ValidationFailed``。不分横竖，只看短边和长边。"""

    if min(width, height) < MIN_SHORT_EDGE_PIXELS:
        raise ValidationFailed(
            f"{width}×{height} 的短边不到 {MIN_SHORT_EDGE_PIXELS}px，这张图太小了"
        )
    if max(width, height) > MAX_LONG_EDGE_PIXELS:
        raise ValidationFailed(
            f"{width}×{height} 的长边超过 {MAX_LONG_EDGE_PIXELS}px，先缩一下再传"
        )


def check_image_bytes(content: bytes) -> None:
    """量一段字节的尺寸并卡区间。``Image.open`` 只读文件头，不解全图。"""

    try:
        with Image.open(io.BytesIO(content)) as image:
            width, height = image.size
    except (UnidentifiedImageError, OSError) as exc:
        raise ValidationFailed("这段字节读不出图片尺寸，不像是一张图") from exc
    check_dimensions(width, height)


__all__ = ["check_dimensions", "check_image_bytes"]
