"""使用 MockTransport 验证素材转存、登记及实际字节的类型、大小和尺寸检测。"""

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
    """仅替换 service 的 httpx 引用，避免影响同样使用 httpx 的 ASGI 测试客户端。"""

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
    """默认提供有效产品图片，可通过间接参数覆盖。"""

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
    """禁止重定向，避免将其他地址返回的内容转存到公开桶。"""

    app = build_test_app(InMemoryAssetRepository(), FakeBucket(), granted=editor())
    async with client(app) as http:
        assert (await import_url(http)).status_code == 422


@pytest.mark.parametrize(
    "upstream",
    [StubUpstream(content=b"\x00\x00\x00\x18ftypmp42", content_type="video/mp4")],
    indirect=True,
)
async def test_videos_carry_no_dimension_check(upstream: StubUpstream) -> None:

    app = build_test_app(InMemoryAssetRepository(), FakeBucket(), granted=editor())
    async with client(app) as http:
        asset = (await import_url(http)).json()["asset"]

    assert asset["assetType"] == "video"
    assert asset["url"].endswith(".mp4")


async def test_an_unreachable_source_is_a_bad_request(upstream: StubUpstream) -> None:

    app = build_test_app(InMemoryAssetRepository(), FakeBucket(), granted=editor())
    async with client(app) as http:
        assert (await import_url(http, "https://pdm.example.test/gone.jpg")).status_code == 422


async def test_reading_does_not_grant_importing(upstream: StubUpstream) -> None:
    app = build_test_app(InMemoryAssetRepository(), FakeBucket(), granted=principal("assets:read"))
    async with client(app) as http:
        assert (await import_url(http)).status_code == 403
