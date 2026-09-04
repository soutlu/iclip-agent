"""素材校验：查台账，查不到或种类不对就让模型改。"""

from __future__ import annotations

import pytest
from pydantic_ai import ModelRetry

from iclip.harness.materials import require_http, require_material
from iclip.platform.material_ledger.store import Material, MaterialKind
from tests.helpers.material_ledger import FakeMaterialLedger

NAMESPACE = "owner/thread-1"
IMAGE = "https://cdn.test/poster.jpg"
VIDEO = "https://cdn.test/ref.mp4"
RECORDED_AT = "版记录记在 frames/grids/ 下，用 read_file 读回来再用。"


@pytest.fixture
def ledger() -> FakeMaterialLedger:
    fake = FakeMaterialLedger()
    fake.rows[(NAMESPACE, IMAGE)] = Material(url=IMAGE, kind="image")
    fake.rows[(NAMESPACE, VIDEO)] = Material(url=VIDEO, kind="video")
    return fake


async def check(ledger: FakeMaterialLedger, url: str, *, kind: MaterialKind = "image") -> None:
    await require_material(
        ledger, NAMESPACE, url, kind=kind, what="图片地址", recorded_at=RECORDED_AT
    )


async def test_recorded_material_passes(ledger: FakeMaterialLedger) -> None:
    await check(ledger, IMAGE)


async def test_unrecorded_material_is_refused(ledger: FakeMaterialLedger) -> None:
    made_up = "https://cdn.test/made-up.jpg"
    with pytest.raises(ModelRetry) as failure:
        await check(ledger, made_up)

    # 不回显被拒的地址：回显一次，模型重试时它就成了「上下文里出现过」的东西。
    assert made_up not in str(failure.value)


async def test_another_conversation_material_is_refused(ledger: FakeMaterialLedger) -> None:
    """台账按命名空间分，别的对话记下的地址在这里查不到。"""

    ledger.rows[("owner/thread-2", "https://cdn.test/别人的.jpg")] = Material(
        url="https://cdn.test/别人的.jpg", kind="image"
    )
    with pytest.raises(ModelRetry):
        await check(ledger, "https://cdn.test/别人的.jpg")


async def test_a_prefix_of_a_recorded_url_is_refused(ledger: FakeMaterialLedger) -> None:
    """逐字比对：记着 ``…/ref.mp4`` 不等于 ``…/ref`` 也能用。"""

    with pytest.raises(ModelRetry):
        await check(ledger, "https://cdn.test/ref", kind="video")


async def test_wrong_kind_is_refused(ledger: FakeMaterialLedger) -> None:
    with pytest.raises(ModelRetry, match="视频"):
        await check(ledger, VIDEO)


@pytest.mark.parametrize("url", ["ref.mp4", "file:///etc/passwd", "ftp://host/a.mp4"])
def test_require_http_refuses_other_schemes(url: str) -> None:
    with pytest.raises(ModelRetry, match="http"):
        require_http(url, what="视频地址")
