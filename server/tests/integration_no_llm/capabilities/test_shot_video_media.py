"""镜头素材：真的起 ffmpeg 跑一遍取帧、拼板与切格。

素材由 ffmpeg 自己合成（不进仓、不下载），经 httpx 的替身传输喂给工具——所以走
的是真实的下载→落盘→子进程这条链，只是没有真的网络。

单测那一层用替身验「工具怎么决策」；这一层验的是**几何真的落到像素上**：切出来
的格子宽度对得上非等分的网格线，拼出来的板真的含全部候选帧。
"""

from __future__ import annotations

import json
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import httpx
import pytest
from pydantic_ai import ModelRetry
from pydantic_ai.messages import ModelRequest, ToolReturn, UserPromptPart
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import RunContext
from pydantic_ai.usage import RunUsage

from iclip.capabilities.shot_video import ffmpeg
from iclip.capabilities.shot_video.capability import (
    ANCHOR_RECORDS_DIR,
    EXTRACTION_PATH,
    GRID_RECORDS_DIR,
    FrameRequest,
    GenerationPolicy,
    ShotVideoToolset,
    shot_video_capability,
    video_doc_path,
)
from iclip.capabilities.shot_video.ffmpeg import ffmpeg_available
from iclip.capabilities.shot_video.grid import grid_cell_boxes, scale_box
from iclip.capabilities.shot_video.ports import ObjectWriteFailed
from iclip.capabilities.workspace.scope import workspace_namespace
from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.identity.models import Principal
from iclip.harness.media import media_tag
from iclip.platform.file_store.store import FileSpace
from iclip.platform.object_store.layout import MEDIA_PATHS
from tests.helpers.file_store import FakeFileStore
from tests.helpers.shot_video import FakeGenerations, FakeObjects, FakeUnderstanding, Outcome

pytestmark = pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe")

GRID_URL = "https://cdn.test/grid.png"
OSS_IMAGE_URL = "https://bucket.oss-cn-hangzhou.aliyuncs.com/style.jpg"
BIG_GRID_URL = "https://cdn.test/grid-4k.png"
VIDEO_URL = "https://cdn.test/clip.mp4"
USER = uuid.UUID("22222222-2222-2222-2222-222222222222")
NAMESPACE = f"{USER}/thread-1"

# 一段 3 秒的片子，切成两个镜头，写成拆解文档第 4 节表格里的一行。
DOCUMENT = (
    "| 结构层级 | Storyline |\n"
    "| Rain-Step Hook | **[00:00.000-00:01.500]** 中景……<br><br>"
    "**[00:01.500-00:03.000]** 特写…… |\n"
)

FAST = GenerationPolicy(poll_interval_seconds=0.001, backoff_seconds=0.001, backoff_factor=1.0)

STORE_DOWN = "OSS 写入失败（试了 3 次）: Read timed out"
"""对象存储那一侧重试完仍没存下来时，经组合根适配器翻过来的那句话。"""


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


_USER_SENT = (
    f"{media_tag('video', VIDEO_URL, name='clip.mp4')}"
    f"{media_tag('image', OSS_IMAGE_URL, name='style.jpg')} 帮我拆一下"
)
"""用户把参考片和参考图发进来之后，模型上下文里的那一行。"""


def make_context(*, said: str = _USER_SENT) -> RunContext[object]:
    """造一次运行的上下文，默认当作素材都已经发进来了。

    工具只收这段对话里出现过的地址（见 `harness/materials.py`）。这一条跑在登记处的验证器
    里，这些用例直接调工具体，绕过它——地址规则本身在单测那一层验。
    """

    deps = AgentRunDeps(
        principal=Principal(
            kind="user",
            user_id=USER,
            permissions=frozenset({"agent:run"}),
            audit_label="luke",
            api_key_id=None,
        ),
        conversation_id="thread-1",
    )
    return RunContext[object](
        deps=deps,
        model=TestModel(),
        usage=RunUsage(),
        messages=[ModelRequest(parts=[UserPromptPart(content=said)])],
    )


def make_tools(
    client: httpx.AsyncClient,
    objects: FakeObjects,
    files: FakeFileStore,
    *,
    generations: FakeGenerations | None = None,
) -> ShotVideoToolset[object]:
    toolset = shot_video_capability(
        space=FileSpace(store=files, namespace=workspace_namespace),
        generations=generations or FakeGenerations(),
        objects=objects,
        paths=MEDIA_PATHS,
        understanding=FakeUnderstanding(),
        client=client,
        policy=FAST,
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


# ── 切格几何：真的落到像素上 ────────────────────────────────────────────────


async def cut(media: dict[str, bytes], url: str) -> list[tuple[int, int]]:
    """按检测到的网格线切一张图，返回每格的实际像素尺寸。"""

    client = make_client(media)
    try:
        async with ffmpeg.fetched(
            client, url, max_bytes=ffmpeg.MAX_IMAGE_BYTES, suffix=".img"
        ) as source:
            gray, full_width = await ffmpeg.decode_gray(source)
            layout = grid_cell_boxes(gray, rows=2, cols=2)
            assert layout.detected, "这张图有清晰的网格线，不该退回等分"
            boxes = [
                scale_box(box, from_width=gray.width, to_width=full_width) for box in layout.boxes
            ]
            cells = await ffmpeg.crop_cells(source, boxes)
    finally:
        await client.aclose()
    return sorted(probe_size(cell) for cell in cells)


async def test_cut_follows_the_real_gutters(media: dict[str, bytes]) -> None:
    """按真实网格线切：四格宽高各不相同，等分切法给不出这个结果。"""

    assert await cut(media, GRID_URL) == SMALL.cell_sizes()


async def test_cut_scales_detection_back_to_full_resolution(media: dict[str, bytes]) -> None:
    """图比 DETECT_WIDTH 宽时检测在缩略图上做，裁剪必须按同一个比例还原回去。

    容差是缩放本身的取整误差（ffmpeg 的高度按 2 对齐，比例又是按宽度算的）。
    """

    sizes = await cut(media, BIG_GRID_URL)
    for (width, height), (want_w, want_h) in zip(sizes, BIG.cell_sizes(), strict=True):
        assert abs(width - want_w) <= 8, f"宽 {width} 离 {want_w} 太远"
        assert abs(height - want_h) <= 8, f"高 {height} 离 {want_h} 太远"


# ── 取帧：整片按秒抽、分板、落账本 ──────────────────────────────────────────


def model_facing(result: ToolReturn[dict[str, Any]]) -> dict[str, Any]:
    """成功那次给模型的那份返回。官方把 ``return_value`` 标成内容联合，不随泛型参数收窄。"""

    payload = result.return_value
    assert isinstance(payload, dict)
    return payload


async def test_plan_extracts_every_second_and_boards_them(media: dict[str, bytes]) -> None:
    """3 秒的片子按秒抽帧：两个镜头共 3 个栅格点，同一个结构层级拼成一张板。"""

    objects = FakeObjects()
    files = FakeFileStore()
    await files.write(NAMESPACE, video_doc_path(VIDEO_URL), DOCUMENT)
    client = make_client(media)
    try:
        result = await make_tools(client, objects, files).plan_shot_frames(
            make_context(), VIDEO_URL
        )
    finally:
        await client.aclose()

    assert isinstance(result, ToolReturn)
    boards = model_facing(result)["boards"]
    assert len(boards) == 1
    # 给人看的那份：一板一张缩略图，标题带板号与镜头号；模型看不到它。
    assert result.metadata == {"items": [{"url": boards[0]["url"], "caption": "板 1 · 1,2"}]}
    assert len(objects.written) == 1
    stored = await files.read(NAMESPACE, EXTRACTION_PATH)
    assert stored is not None
    ledger = json.loads(stored.content)
    cells = [cell["id"] for board in ledger["boards"] for cell in board["cells"]]
    # 栅格是全片统一的 0/1000/2000ms：镜头 1 拿到 0 与 1000，镜头 2 拿到 2000。
    assert cells == ["S1-1", "S1-2", "S2-1"]


async def test_plan_reuses_the_ledger_instead_of_extracting_again(
    media: dict[str, bytes],
) -> None:
    """同一份视频加同一份拆解文档，第二次直接复用，不重抽也不重传。"""

    objects = FakeObjects()
    files = FakeFileStore()
    await files.write(NAMESPACE, video_doc_path(VIDEO_URL), DOCUMENT)
    client = make_client(media)
    try:
        tools = make_tools(client, objects, files)
        await tools.plan_shot_frames(make_context(), VIDEO_URL)
        again = await tools.plan_shot_frames(make_context(), VIDEO_URL)
    finally:
        await client.aclose()

    assert isinstance(again, ToolReturn)
    assert "复用既有账本" in model_facing(again)["message"]
    assert len(objects.written) == 1


async def test_plan_refuses_timecodes_beyond_the_clip(media: dict[str, bytes]) -> None:
    """超出时长的时间码要说清楚这段片子有多长，模型才改得动。"""

    files = FakeFileStore()
    await files.write(NAMESPACE, video_doc_path(VIDEO_URL), "**[00:00.000-00:09.000]** 中景")
    client = make_client(media)
    try:
        with pytest.raises(ModelRetry, match="越界"):
            await make_tools(client, FakeObjects(), files).plan_shot_frames(
                make_context(), VIDEO_URL
            )
    finally:
        await client.aclose()


async def test_plan_asks_for_a_retry_when_a_board_cannot_be_stored(
    media: dict[str, bytes],
) -> None:
    """预览板没存下来是一句可重试提示，不是整次运行中断；账本也不能留——留了的话下一
    次调用会当成已完成直接复用，而板的地址根本不存在。"""

    objects = FakeObjects(error=ObjectWriteFailed(STORE_DOWN))
    files = FakeFileStore()
    await files.write(NAMESPACE, video_doc_path(VIDEO_URL), DOCUMENT)
    client = make_client(media)
    try:
        with pytest.raises(ModelRetry, match="重新调用一次"):
            await make_tools(client, objects, files).plan_shot_frames(make_context(), VIDEO_URL)
    finally:
        await client.aclose()

    assert await files.read(NAMESPACE, EXTRACTION_PATH) is None


# ── 按批出帧：收敛后真的切格、落帧、写版记录 ────────────────────────────────


async def test_generate_cuts_the_grid_and_records_the_batch(media: dict[str, bytes]) -> None:
    """一次两格：切出四格只留前两格，版记录里逐帧带上它的 prompt。"""

    objects = FakeObjects()
    files = FakeFileStore()
    await files.write(NAMESPACE, video_doc_path(VIDEO_URL), DOCUMENT)
    generations = FakeGenerations(outcomes=[Outcome(output_url=GRID_URL)])
    client = make_client(media)
    try:
        tools = make_tools(client, objects, files, generations=generations)
        await tools.plan_shot_frames(make_context(), VIDEO_URL)
        boards_written = len(objects.written)
        result = await tools.generate_shot_frames(
            make_context(),
            [
                FrameRequest(no="S1-1", prompt="雨中中景"),
                FrameRequest(no="S2-1", prompt="鞋底特写"),
            ],
            [],
            "全局参考设定 @Image1",
            "9:16",
        )
    finally:
        await client.aclose()

    assert isinstance(result, ToolReturn)
    payload = model_facing(result)
    assert payload["status"] == "done"
    assert [frame["no"] for frame in payload["frames"]] == ["S1-1", "S2-1"]
    assert [frame["shot"] for frame in payload["frames"]] == [1, 2]
    assert len(objects.written) == boards_written + 2
    # 给人看的那份：一帧一张缩略图，按帧号顺序，标题就是帧号。
    assert result.metadata == {
        "items": [{"url": frame["url"], "caption": frame["no"]} for frame in payload["frames"]]
    }

    stored = await files.read(NAMESPACE, payload["record"])
    assert stored is not None
    record = json.loads(stored.content)
    assert record["gridUrl"] == GRID_URL
    assert [frame["prompt"] for frame in record["frames"]] == ["雨中中景", "鞋底特写"]


async def test_generate_reports_an_unreachable_grid_without_pretending_it_worked(
    media: dict[str, bytes],
) -> None:
    """图出了但取不回来是失败，不是空结果——错误要带着记录 id 报出去。"""

    files = FakeFileStore()
    await files.write(NAMESPACE, video_doc_path(VIDEO_URL), DOCUMENT)
    generations = FakeGenerations(outcomes=[Outcome(output_url="https://cdn.test/gone.png")])
    client = make_client(media)
    try:
        tools = make_tools(client, FakeObjects(), files, generations=generations)
        await tools.plan_shot_frames(make_context(), VIDEO_URL)
        result = await tools.generate_shot_frames(
            make_context(), [FrameRequest(no="S1-1", prompt="猫")], [], "全局", "9:16"
        )
    finally:
        await client.aclose()

    # 失败没有图可给人看：照旧是 dict，不裹 ToolReturn。
    assert isinstance(result, dict)
    assert result["status"] == "failed"
    assert result["frames"] == []
    assert "取不到素材" in result["error"]


async def test_generate_reports_unstored_frames_without_calling_the_generation_failed(
    media: dict[str, bytes],
) -> None:
    """图出了也计费了，只是切出来的帧没存下来：带着记录 id 说清这一点，不报成「生成
    失败」；版记录也不留——里面没有一个能用的地址。"""

    objects = FakeObjects()
    files = FakeFileStore()
    await files.write(NAMESPACE, video_doc_path(VIDEO_URL), DOCUMENT)
    generations = FakeGenerations(outcomes=[Outcome(output_url=GRID_URL)])
    client = make_client(media)
    try:
        tools = make_tools(client, objects, files, generations=generations)
        await tools.plan_shot_frames(make_context(), VIDEO_URL)
        objects.error = ObjectWriteFailed(STORE_DOWN)
        result = await tools.generate_shot_frames(
            make_context(), [FrameRequest(no="S1-1", prompt="猫")], [], "全局", "9:16"
        )
    finally:
        await client.aclose()

    assert isinstance(result, dict)
    assert result["status"] == "failed"
    assert result["frames"] == []
    assert "生成失败" not in result["message"]
    assert "生成已完成" in result["message"]
    assert str(generations.job_ids[0]) in result["error"]
    assert "Read timed out" in result["error"]
    assert not await files.entries(NAMESPACE, prefix=GRID_RECORDS_DIR)


async def test_anchor_sheet_reports_unstored_cells_the_same_way(media: dict[str, bytes]) -> None:
    objects = FakeObjects(error=ObjectWriteFailed(STORE_DOWN))
    files = FakeFileStore()
    generations = FakeGenerations(outcomes=[Outcome(output_url=GRID_URL)])
    client = make_client(media)
    try:
        result = await make_tools(
            client, objects, files, generations=generations
        ).generate_anchor_sheet(make_context(), ["全身正面平视的女性"])
    finally:
        await client.aclose()

    assert isinstance(result, dict)
    assert result["status"] == "failed"
    assert result["images"] == []
    assert "生成失败" not in result["message"]
    assert not await files.entries(NAMESPACE, prefix=ANCHOR_RECORDS_DIR)


async def test_anchor_sheet_cuts_the_sheet_and_records_each_entity(
    media: dict[str, bytes],
) -> None:
    """补拍两格：切出四格只留前两格，版记录里逐格带上它的描述。

    补拍不做画幅收缩，所以切出来的就是网格线量出的那块——两格字节不同正是「按线
    切」的证据（那张合成图四格颜色各异）。
    """

    objects = FakeObjects()
    files = FakeFileStore()
    generations = FakeGenerations(outcomes=[Outcome(output_url=GRID_URL)])
    client = make_client(media)
    try:
        tools = make_tools(client, objects, files, generations=generations)
        result = await tools.generate_anchor_sheet(
            make_context(), ["全身正面平视的女性", "空景全景平视的门厅"]
        )
    finally:
        await client.aclose()

    assert isinstance(result, ToolReturn)
    payload = model_facing(result)
    assert payload["status"] == "done"
    assert [image["index"] for image in payload["images"]] == [1, 2]
    assert len(objects.written) == 2
    # 给人看的那份：一格一张缩略图，标题是那一格的描述（模型那份里只有序号与地址）。
    assert result.metadata == {
        "items": [
            {"url": payload["images"][0]["url"], "caption": "全身正面平视的女性"},
            {"url": payload["images"][1]["url"], "caption": "空景全景平视的门厅"},
        ]
    }

    stored = await files.read(NAMESPACE, payload["record"])
    assert stored is not None
    record = json.loads(stored.content)
    assert record["gridUrl"] == GRID_URL
    assert [cell["description"] for cell in record["cells"]] == [
        "全身正面平视的女性",
        "空景全景平视的门厅",
    ]
    written = list(objects.written.values())
    assert written[0] != written[1]


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
