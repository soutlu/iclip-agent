"""T-ASSET-03：``POST /assets/import``——外部地址搬进桶里、登记、给出新地址。

上游用 httpx 的 ``MockTransport`` 顶着：转存这条路的字节确实穿过我们的进程，所以类型、
大小、尺寸都是实测的，这里要验的正是「实测」这件事。
"""

from __future__ import annotations

import io
import uuid

import httpx
import pytest
from PIL import Image

from iclip.domains.assets import service as service_module
from iclip.domains.assets.models import MAX_LONG_EDGE_PIXELS, MIN_SHORT_EDGE_PIXELS
from tests.helpers.assets import FakeBucket, InMemoryAssetRepository
from tests.unit.domains.assets.test_assets_api import build_test_app, client, editor, principal

SOURCE = "https://pdm.example.test/styles/SBPU24001W/1.jpg"


def jpeg(width: int, height: int) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, format="JPEG")
    return buffer.getvalue()


class StubUpstream:
    """替掉 service 模块里那个 ``httpx`` 名字：地址 → 一次响应。

    替的是模块里的名字而不是 httpx 本身——ASGI 测试客户端自己也在用真的 httpx。
    """

    HTTPError = httpx.HTTPError

    def __init__(self, *, content: bytes, content_type: str, status: int = 200) -> None:
        self._content = content
        self._content_type = content_type
        self._status = status
        self.asked: list[str] = []

    def AsyncClient(self, **_kwargs: object) -> httpx.AsyncClient:
        def handle(request: httpx.Request) -> httpx.Response:
            self.asked.append(str(request.url))
            if str(request.url) != SOURCE:
                return httpx.Response(404)
            return httpx.Response(
                self._status,
                content=self._content,
                headers={"Content-Type": self._content_type},
            )

        return httpx.AsyncClient(transport=httpx.MockTransport(handle))


@pytest.fixture
def upstream(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> StubUpstream:
    """默认上游是一张合规的产品图；要别的用 ``@pytest.mark.parametrize`` 之外的间接参数。"""

    stub: StubUpstream = getattr(request, "param", None) or StubUpstream(
        content=jpeg(1200, 1600), content_type="image/jpeg"
    )
    monkeypatch.setattr(service_module, "httpx", stub)
    return stub


async def import_url(http: httpx.AsyncClient, url: str = SOURCE) -> httpx.Response:
    return await http.post("/assets/import", json={"url": url})


async def test_import_mirrors_the_bytes_and_hands_back_our_own_url(
    upstream: StubUpstream,
) -> None:
    """外部地址进不了账本（行上只有 object_key），所以必须先搬过来。"""

    bucket = FakeBucket()
    repo = InMemoryAssetRepository()
    me = uuid.uuid4()
    app = build_test_app(repo, bucket, granted=editor(me))
    async with client(app) as http:
        response = await import_url(http)

    asset = response.json()["asset"]
    assert response.status_code == 201
    assert asset["assetType"] == "image"
    assert asset["contentType"] == "image/jpeg"
    assert asset["sizeBytes"] == len(jpeg(1200, 1600))
    assert asset["creatorUserId"] == str(me)
    assert asset["url"] == f"https://cdn.test/iclip/agent/uploads/{asset['id']}.jpg"
    assert f"iclip/agent/uploads/{asset['id']}.jpg" in bucket.objects


async def test_the_same_source_is_only_fetched_once(upstream: StubUpstream) -> None:
    """源地址算 id：同一张产品图被多少张需求单引用，都只搬一次、只有一行。"""

    repo = InMemoryAssetRepository()
    app = build_test_app(repo, FakeBucket(), granted=editor())
    async with client(app) as http:
        first = await import_url(http)
        again = await import_url(http)

    assert first.json() == again.json()
    assert len(repo.assets) == 1
    assert upstream.asked == [SOURCE]


@pytest.mark.parametrize(
    "upstream",
    [
        StubUpstream(content=jpeg(MIN_SHORT_EDGE_PIXELS - 1, 4000), content_type="image/jpeg"),
        StubUpstream(content=jpeg(MAX_LONG_EDGE_PIXELS + 1, 400), content_type="image/jpeg"),
    ],
    indirect=True,
    ids=["too-small", "too-large"],
)
async def test_out_of_range_images_get_no_row(upstream: StubUpstream) -> None:
    """转存这条路尺寸是量出来的，不是听来的。"""

    bucket = FakeBucket()
    repo = InMemoryAssetRepository()
    app = build_test_app(repo, bucket, granted=editor())
    async with client(app) as http:
        response = await import_url(http)

    assert response.status_code == 422
    assert repo.assets == {}
    assert bucket.objects == {}


@pytest.mark.parametrize(
    "upstream",
    [StubUpstream(content=b"%PDF-1.7", content_type="application/pdf")],
    indirect=True,
)
async def test_unsupported_upstream_types_are_refused(upstream: StubUpstream) -> None:
    app = build_test_app(InMemoryAssetRepository(), FakeBucket(), granted=editor())
    async with client(app) as http:
        assert (await import_url(http)).status_code == 422


@pytest.mark.parametrize(
    "upstream",
    [StubUpstream(content=b"", content_type="image/jpeg", status=302)],
    indirect=True,
)
async def test_redirects_are_not_followed(upstream: StubUpstream) -> None:
    """搬回来的字节会落进公开桶：跟着 302 走就等于把这条口子借给了任意地址。"""

    app = build_test_app(InMemoryAssetRepository(), FakeBucket(), granted=editor())
    async with client(app) as http:
        assert (await import_url(http)).status_code == 422


@pytest.mark.parametrize(
    "upstream",
    [StubUpstream(content=b"\x00\x00\x00\x18ftypmp42", content_type="video/mp4")],
    indirect=True,
)
async def test_videos_carry_no_dimension_check(upstream: StubUpstream) -> None:
    """爆款库那条路搬的是片子；尺寸这道闸只管图。"""

    app = build_test_app(InMemoryAssetRepository(), FakeBucket(), granted=editor())
    async with client(app) as http:
        asset = (await import_url(http)).json()["asset"]

    assert asset["assetType"] == "video"
    assert asset["url"].endswith(".mp4")


async def test_an_unreachable_source_is_a_bad_request(upstream: StubUpstream) -> None:
    """上游取不回来，问题在给进来的那个地址上，不在我们这儿。"""

    app = build_test_app(InMemoryAssetRepository(), FakeBucket(), granted=editor())
    async with client(app) as http:
        assert (await import_url(http, "https://pdm.example.test/gone.jpg")).status_code == 422


async def test_reading_does_not_grant_importing(upstream: StubUpstream) -> None:
    app = build_test_app(InMemoryAssetRepository(), FakeBucket(), granted=principal("assets:read"))
    async with client(app) as http:
        assert (await import_url(http)).status_code == 403
