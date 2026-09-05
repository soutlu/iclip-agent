"""使用 ffmpeg 合成媒体，通过 MockTransport 验证下载、取帧、拼板和非等分切格的像素结果。"""

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
from iclip.capabilities.shot_video.capability import GenerationPolicy, shot_video_capability
from iclip.capabilities.shot_video.delivery import FrameRequest
from iclip.capabilities.shot_video.extraction import EXTRACTION_PATH, video_doc_path
from iclip.capabilities.shot_video.ffmpeg import ffmpeg_available
from iclip.capabilities.shot_video.generation import ANCHOR_RECORDS_DIR, GRID_RECORDS_DIR
from iclip.capabilities.shot_video.grid import grid_cell_boxes, scale_box
from iclip.capabilities.shot_video.ports import ObjectWriteFailed
from iclip.capabilities.shot_video.toolset import ShotVideoToolset
from iclip.capabilities.workspace.scope import workspace_namespace
from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.identity.models import Principal
from iclip.harness.media import media_tag
from iclip.platform.file_store.store import FileSpace
from iclip.platform.object_store.layout import MEDIA_PATHS
from tests.helpers.file_store import FakeFileStore
from tests.helpers.material_ledger import FakeMaterialLedger
from tests.helpers.shot_video import FakeGenerations, FakeObjects, FakeUnderstanding, Outcome

pytestmark = pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe")

GRID_URL = "https://cdn.test/grid.png"
OSS_IMAGE_URL = "https://bucket.oss-cn-hangzhou.aliyuncs.com/style.jpg"
BIG_GRID_URL = "https://cdn.test/grid-4k.png"
VIDEO_URL = "https://cdn.test/clip.mp4"
USER = uuid.UUID("22222222-2222-2222-2222-222222222222")
NAMESPACE = f"{USER}/thread-1"

DOCUMENT = (
    "| 结构层级 | Storyline |\n"
    "| Rain-Step Hook | **[00:00.000-00:01.500]** 中景……<br><br>"
    "**[00:01.500-00:03.000]** 特写…… |\n"
)

FAST = GenerationPolicy(poll_interval_seconds=0.001, backoff_seconds=0.001, backoff_factor=1.0)

STORE_DOWN = "OSS 写入失败（试了 3 次）: Read timed out"
"""对象存储重试耗尽后，由组合根映射的错误消息。"""


@dataclass(frozen=True, slots=True)
class Grid:
    """四格尺寸不同、分隔线偏离等分位置的 2×2 网格，用于识别错误的等分裁切。"""

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
"""宽度小于 DETECT_WIDTH，覆盖无需缩放的坐标还原。"""

BIG = Grid(left=600, gutter_w=20, right=780, top=500, gutter_h=20, bottom=680)
"""宽度大于 DETECT_WIDTH，覆盖缩略图到原图的坐标还原。"""


def run_ffmpeg(args: list[str]) -> None:
    result = subprocess.run(["ffmpeg", "-v", "error", "-y", *args], capture_output=True)
    if result.returncode != 0:
        raise AssertionError(result.stderr.decode(errors="replace"))


def make_grid_png(path: Path, grid: Grid) -> bytes:
    """合成含四个纯色格、白色分隔带和外边框的 2×2 图片。"""

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
    """合成三秒动态图样视频，使不同时间的抽帧可区分。"""

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
    """用固定 URL 响应替代网络，保留真实下载流程。"""

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
"""模拟用户已提供参考视频和图片的上下文。"""


def make_context(*, said: str = _USER_SENT) -> RunContext[object]:
    """直接调用工具体，默认素材已登记；注册表上的地址范围校验由单测覆盖。"""

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
    ledger: FakeMaterialLedger | None = None,
) -> ShotVideoToolset[object]:
    toolset = shot_video_capability(
        space=FileSpace(store=files, namespace=workspace_namespace),
        ledger=ledger or FakeMaterialLedger(),
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

    assert await cut(media, GRID_URL) == SMALL.cell_sizes()


async def test_cut_scales_detection_back_to_full_resolution(media: dict[str, bytes]) -> None:
    """缩略图检测坐标须还原到原分辨率；容差覆盖 ffmpeg 高度偶数对齐的取整误差。"""

    sizes = await cut(media, BIG_GRID_URL)
    for (width, height), (want_w, want_h) in zip(sizes, BIG.cell_sizes(), strict=True):
        assert abs(width - want_w) <= 8, f"宽 {width} 离 {want_w} 太远"
        assert abs(height - want_h) <= 8, f"高 {height} 离 {want_h} 太远"


def model_facing(result: ToolReturn[dict[str, Any]]) -> dict[str, Any]:
    """提取模型侧返回；return_value 联合类型需先收窄。"""

    payload = result.return_value
    assert isinstance(payload, dict)
    return payload


async def test_plan_extracts_every_second_and_boards_them(media: dict[str, bytes]) -> None:

    objects = FakeObjects()
    files = FakeFileStore()
    materials = FakeMaterialLedger()
    await files.write(NAMESPACE, video_doc_path(VIDEO_URL), DOCUMENT)
    client = make_client(media)
    try:
        result = await make_tools(client, objects, files, ledger=materials).plan_shot_frames(
            make_context(), VIDEO_URL
        )
    finally:
        await client.aclose()

    assert isinstance(result, ToolReturn)
    boards = model_facing(result)["boards"]
    assert len(boards) == 1
    assert materials.urls(NAMESPACE) == {boards[0]["url"]}
    assert result.metadata == {"items": [{"url": boards[0]["url"], "caption": "板 1 · 1,2"}]}
    assert len(objects.written) == 1
    stored = await files.read(NAMESPACE, EXTRACTION_PATH)
    assert stored is not None
    ledger = json.loads(stored.content)
    cells = [cell["id"] for board in ledger["boards"] for cell in board["cells"]]
    assert cells == ["S1-1", "S1-2", "S2-1"]


async def test_plan_reuses_the_ledger_instead_of_extracting_again(
    media: dict[str, bytes],
) -> None:

    objects = FakeObjects()
    files = FakeFileStore()
    materials = FakeMaterialLedger()
    await files.write(NAMESPACE, video_doc_path(VIDEO_URL), DOCUMENT)
    client = make_client(media)
    try:
        tools = make_tools(client, objects, files, ledger=materials)
        await tools.plan_shot_frames(make_context(), VIDEO_URL)
        again = await tools.plan_shot_frames(make_context(), VIDEO_URL)
    finally:
        await client.aclose()

    assert isinstance(again, ToolReturn)
    assert "复用既有账本" in model_facing(again)["message"]
    assert len(objects.written) == 1
    # 复用时也需登记预览板地址，保证后续工具可引用。
    assert materials.urls(NAMESPACE) == {model_facing(again)["boards"][0]["url"]}


async def test_plan_refuses_timecodes_beyond_the_clip(media: dict[str, bytes]) -> None:
    """时间码超出时长时需返回实际时长，供模型修正。"""

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
    """预览板存储失败需返回可重试错误且不落账本，避免下次复用不存在的地址。"""

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


async def test_generate_cuts_the_grid_and_records_the_batch(media: dict[str, bytes]) -> None:

    objects = FakeObjects()
    files = FakeFileStore()
    materials = FakeMaterialLedger()
    await files.write(NAMESPACE, video_doc_path(VIDEO_URL), DOCUMENT)
    generations = FakeGenerations(outcomes=[Outcome(output_url=GRID_URL)])
    client = make_client(media)
    try:
        tools = make_tools(client, objects, files, generations=generations, ledger=materials)
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
    assert result.metadata == {
        "items": [{"url": frame["url"], "caption": frame["no"]} for frame in payload["frames"]]
    }

    stored = await files.read(NAMESPACE, payload["record"])
    assert stored is not None
    record = json.loads(stored.content)
    assert record["gridUrl"] == GRID_URL
    assert [frame["prompt"] for frame in record["frames"]] == ["雨中中景", "鞋底特写"]
    assert {frame["url"] for frame in payload["frames"]} | {GRID_URL} <= materials.urls(NAMESPACE)


async def test_generate_reports_an_unreachable_grid_without_pretending_it_worked(
    media: dict[str, bytes],
) -> None:

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

    assert isinstance(result, dict)
    assert result["status"] == "failed"
    assert result["frames"] == []
    assert "取不到素材" in result["error"]


async def test_generate_reports_unstored_frames_without_calling_the_generation_failed(
    media: dict[str, bytes],
) -> None:
    """切格存储失败发生在付费生成之后，需区分错误阶段并返回记录 id，不保存无效版记录。"""

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
    """补拍不收缩画幅；不同颜色格产生不同字节，验证按检测网格线切分。"""

    objects = FakeObjects()
    files = FakeFileStore()
    materials = FakeMaterialLedger()
    generations = FakeGenerations(outcomes=[Outcome(output_url=GRID_URL)])
    client = make_client(media)
    try:
        tools = make_tools(client, objects, files, generations=generations, ledger=materials)
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
    assert {image["url"] for image in payload["images"]} | {GRID_URL} <= materials.urls(NAMESPACE)


def probe_size(data: bytes) -> tuple[int, int]:

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
