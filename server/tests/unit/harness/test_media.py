"""挂在图片地址上的 OSS 处理参数：缩放与裁切怎么拼，什么地址挂不上去。

全是纯字符串函数，不出网——真的裁没裁对是对象存储那一侧的事。
"""

from __future__ import annotations

import pytest

from iclip.harness.media import cropped_image_url, resized_image_url

OSS = "https://bucket.oss-cn-hangzhou.aliyuncs.com/style.jpg"


def test_crop_uses_original_pixel_coordinates() -> None:
    assert (
        cropped_image_url(OSS, x=100, y=200, width=800, height=600, max_edge=None)
        == f"{OSS}?x-oss-process=image/crop,x_100,y_200,w_800,h_600"
    )


def test_crop_then_resize_cascades_in_that_order() -> None:
    """顺序要紧：OSS 按 ``/`` 依次处理，所以缩的是裁出来的那块，不是原图。"""

    assert (
        cropped_image_url(OSS, x=0, y=0, width=3000, height=2000, max_edge=1024)
        == f"{OSS}?x-oss-process=image/crop,x_0,y_0,w_3000,h_2000/resize,l_1024"
    )


@pytest.mark.parametrize(
    "url",
    [
        "https://cdn.test/style.jpg",
        f"{OSS}?x-oss-process=image/resize,l_512",
    ],
)
def test_an_address_that_cannot_carry_the_parameter_is_refused(url: str) -> None:
    """挂不上去就抛，不原样返回：拼出来的废地址在厂商那侧才失败，更难查。"""

    with pytest.raises(ValueError, match="缩放参数"):
        cropped_image_url(url, x=0, y=0, width=10, height=10, max_edge=None)
    with pytest.raises(ValueError, match="缩放参数"):
        resized_image_url(url, max_edge=1024)
