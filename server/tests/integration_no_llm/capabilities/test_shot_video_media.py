"""镜头素材：真的起 ffmpeg 跑一遍抽帧与切格。

素材由 ffmpeg 自己合成（不进仓、不下载），经 httpx 的替身传输喂给工具——所以走
的是真实的下载→落盘→子进程这条链，只是没有真的网络。

单测那一层用替身验「工具怎么决策」；这一层验的是**几何真的落到像素上**：切出来
的格子宽度对得上非等分的网格线，抽出来的帧真的是那个时刻的画面。
"""

from __future__ import annotations

import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx
import pytest
from pydantic_ai import ModelRetry
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import RunContext
from pydantic_ai.usage import RunUsage

from iclip.capabilities.shot_video.capability import ShotVideoToolset, shot_video_capability
from iclip.capabilities.shot_video.ffmpeg import ffmpeg_available
from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.identity.models import Principal
from tests.helpers.shot_video import FakeGenerations, FakeObjects, FakeUnderstanding

pytestmark = pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe")

GRID_URL = "https://cdn.test/grid.png"
BIG_GRID_URL = "https://cdn.test/grid-4k.png"
VIDEO_URL = "https://cdn.test/clip.mp4"


@dataclass(frozen=True, slots=True)
class Grid:
    """一张 2×2 拼图的尺寸。四块的宽高都不相等，网格线也不在等分线上——等分
    切法在这种图上必然切错，所以「切对了」这件事是可判定的。"""

    left: int
    gutter_w: int
    right: int
    top: int
    gutter_h: int
    bottom: int

    @property
    def width(self) -> int:
        return self.left + self.gutter_w + self.right

    @property
    def height(self) -> int:
        return self.top + self.gutter_h + self.bottom

    def cell_sizes(self) -> list[tuple[int, int]]:
        return sorted(
            [
                (self.left, self.top),
                (self.right, self.top),
                (self.left, self.bottom),
                (self.right, self.bottom),
            ]
        )


SMALL = Grid(left=180, gutter_w=6, right=218, top=150, gutter_h=6, bottom=248)
"""比 DETECT_WIDTH 窄：解码时不缩放，走的是坐标还原的恒等路径。"""

BIG = Grid(left=600, gutter_w=20, right=780, top=500, gutter_h=20, bottom=680)
"""比 DETECT_WIDTH 宽：检测在缩略图上做，裁剪要按比例还原回原图坐标。"""


def run_ffmpeg(args: list[str]) -> None:
    result = subprocess.run(["ffmpeg", "-v", "error", "-y", *args], capture_output=True)
    if result.returncode != 0:
        raise AssertionError(result.stderr.decode(errors="replace"))


def make_grid_png(path: Path, grid: Grid) -> bytes:
    """合成一张 2×2 拼图：四块纯色，中间留白色格间距，外面留一圈白边。"""

    boxes = [
        (0, 0, grid.left, grid.top, "red"),
        (grid.left + grid.gutter_w, 0, grid.right, grid.top, "green"),
        (0, grid.top + grid.gutter_h, grid.left, grid.bottom, "blue"),
        (grid.left + grid.gutter_w, grid.top + grid.gutter_h, grid.right, grid.bottom, "orange"),
    ]
    filters = ",".join(
        f"drawbox=x={x}:y={y}:w={w}:h={h}:color={color}@1:t=fill" for x, y, w, h, color in boxes
    )
    run_ffmpeg(
        [
            "-f",
            "lavfi",
            "-i",
            f"color=c=white:s={grid.width}x{grid.height}",
            "-vf",
            filters,
            "-frames:v",
            "1",
            str(path),
        ]
    )
    return path.read_bytes()


def make_clip_mp4(path: Path) -> bytes:
    """合成一段 3 秒的测试图样视频（画面随时间变化，抽到的帧因此可分辨）。"""

    run_ffmpeg(
        [
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=10:duration=3",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ]
    )
    return path.read_bytes()


def make_client(payloads: dict[str, bytes]) -> httpx.AsyncClient:
    """一个只认得几个固定地址的 httpx 客户端：真下载路径，假网络。"""

    def handler(request: httpx.Request) -> httpx.Response:
        body = payloads.get(str(request.url))
        if body is None:
            return httpx.Response(404)
        return httpx.Response(200, content=body)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def make_context() -> RunContext[object]:
    deps = AgentRunDeps(
        principal=Principal(
            kind="user",
            user_id=uuid.uuid4(),
            permissions=frozenset({"agent:run"}),
            audit_label="luke",
            api_key_id=None,
        ),
        conversation_id="thread-1",
    )
    return RunContext[object](deps=deps, model=TestModel(), usage=RunUsage())


def make_tools(client: httpx.AsyncClient, objects: FakeObjects) -> ShotVideoToolset[object]:
    toolset = shot_video_capability(
        generations=FakeGenerations(),
        objects=objects,
        understanding=FakeUnderstanding(),
        client=client,
    ).get_toolset()
    assert isinstance(toolset, ShotVideoToolset)
    return toolset


@pytest.fixture
def media() -> dict[str, bytes]:
    with TemporaryDirectory(prefix="shot-video-fixtures-") as tmp:
        root = Path(tmp)
        return {
            GRID_URL: make_grid_png(root / "grid.png", SMALL),
            BIG_GRID_URL: make_grid_png(root / "grid-4k.png", BIG),
            VIDEO_URL: make_clip_mp4(root / "clip.mp4"),
        }


async def test_cut_grid_follows_the_real_gutters(media: dict[str, bytes]) -> None:
    """按真实网格线切：四格宽高各不相同，等分切法给不出这个结果。"""

    objects = FakeObjects()
    client = make_client(media)
    try:
        result = await make_tools(client, objects).cut_grid_image(make_context(), GRID_URL)
    finally:
        await client.aclose()

    assert "按图上真实的网格线切的" in str(result.return_value)
    assert len(objects.written) == 4
    sizes = sorted(probe_size(data) for data in objects.written.values())
    assert sizes == SMALL.cell_sizes()


async def test_cut_grid_scales_detection_back_to_full_resolution(
    media: dict[str, bytes],
) -> None:
    """图比 DETECT_WIDTH 宽时检测在缩略图上做，裁剪必须按同一个比例还原回去。

    容差是缩放本身的取整误差（ffmpeg 的高度按 2 对齐，比例又是按宽度算的）。
    """

    objects = FakeObjects()
    client = make_client(media)
    try:
        result = await make_tools(client, objects).cut_grid_image(make_context(), BIG_GRID_URL)
    finally:
        await client.aclose()

    assert "按图上真实的网格线切的" in str(result.return_value)
    sizes = sorted(probe_size(data) for data in objects.written.values())
    for (width, height), (want_w, want_h) in zip(sizes, BIG.cell_sizes(), strict=True):
        assert abs(width - want_w) <= 8, f"宽 {width} 离 {want_w} 太远"
        assert abs(height - want_h) <= 8, f"高 {height} 离 {want_h} 太远"


async def test_cut_grid_attaches_pictures_for_the_model(media: dict[str, bytes]) -> None:
    """切完的画面要附在结果里，不然模型只拿到一串它看不见的地址。"""

    client = make_client(media)
    try:
        result = await make_tools(client, FakeObjects()).cut_grid_image(make_context(), GRID_URL)
    finally:
        await client.aclose()

    assert result.content is not None
    assert len(result.content) == 4


async def test_cut_grid_to_target_aspect(media: dict[str, bytes]) -> None:
    objects = FakeObjects()
    client = make_client(media)
    try:
        await make_tools(client, objects).cut_grid_image(
            make_context(), GRID_URL, target_aspect="1:1"
        )
    finally:
        await client.aclose()

    for width, height in (probe_size(data) for data in objects.written.values()):
        assert abs(width / height - 1.0) < 0.05


async def test_extract_frames_at_given_timecodes(media: dict[str, bytes]) -> None:
    objects = FakeObjects()
    client = make_client(media)
    try:
        result = await make_tools(client, objects).extract_video_frames(
            make_context(), VIDEO_URL, ["00:00.500", "00:02.000"]
        )
    finally:
        await client.aclose()

    text = str(result.return_value)
    assert "00:00.500" in text and "00:02.000" in text
    assert len(objects.written) == 2
    # 画面随时间变化，两帧内容不同——同一个内容会被内容寻址的 key 合成一个对象。
    assert all(probe_size(data) == (320, 240) for data in objects.written.values())
    assert result.content is not None and len(result.content) == 2


async def test_timecode_beyond_duration_is_refused(media: dict[str, bytes]) -> None:
    """超出时长的时间码要说清楚这段片子有多长，模型才改得动。"""

    client = make_client(media)
    try:
        with pytest.raises(ModelRetry, match="超出了视频时长"):
            await make_tools(client, FakeObjects()).extract_video_frames(
                make_context(), VIDEO_URL, ["00:09.000"]
            )
    finally:
        await client.aclose()


async def test_unreachable_media_fails_with_a_retryable_message() -> None:
    client = make_client({})
    try:
        with pytest.raises(ModelRetry, match="取不到素材"):
            await make_tools(client, FakeObjects()).cut_grid_image(make_context(), GRID_URL)
    finally:
        await client.aclose()


def probe_size(data: bytes) -> tuple[int, int]:
    """用 ffprobe 量一张图的实际像素尺寸。"""

    with TemporaryDirectory(prefix="shot-video-probe-") as tmp:
        path = Path(tmp) / "image.jpg"
        path.write_bytes(data)
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "csv=p=0:s=x",
                str(path),
            ],
            capture_output=True,
        )
        if result.returncode != 0:
            raise AssertionError(result.stderr.decode(errors="replace"))
        width, height = result.stdout.decode().strip().split("x")
        return int(width), int(height)
