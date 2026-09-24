"""视频拆解文档、镜头时间区间与取帧台账的生成和读取。"""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Sequence
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Annotated, Final

import httpx
import structlog
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from pydantic.alias_generators import to_camel
from pydantic_ai import ModelRetry

from iclip.capabilities.shot_video.board import (
    BoardError,
    board_geometry,
    compose_board,
    image_aspect,
)
from iclip.capabilities.shot_video.ffmpeg import extract_frames
from iclip.capabilities.shot_video.ports import (
    ObjectWriteFailed,
    PublicObjectWriter,
    ShotVideoPaths,
)
from iclip.capabilities.shot_video.shots import (
    FRAME_INTERVAL_MS,
    SHOT_TIMECODE_SHAPE,
    ShotParseError,
    ShotSpan,
    extraction_key,
    parse_shot_rows,
    sample_rows,
)
from iclip.platform.file_store.store import FileStore
from iclip.platform.media.ffmpeg import MAX_VIDEO_BYTES, MediaError, fetched, probe_duration_ms

EXTRACTION_PATH: Final = "frames/extraction.json"
EXTRACTION_VERSION: Final = 1

_JPEG: Final = "image/jpeg"

_logger = structlog.stdlib.get_logger(__name__)


class LedgerBoard(BaseModel):
    """台账里的一块预览板：板号从 1 起，对应拆解文档的第几个结构层级。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    board: Annotated[int, Field(strict=True, ge=1)]
    url: str


class ExtractionLedger(BaseModel):
    """取帧台账 ``frames/extraction.json`` 的结构，磁盘上字段名是 camelCase。

    文件在模型可写的工作区里，读回时按本模型校验。"""

    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )

    extraction_version: int
    extraction_key: str
    boards: list[LedgerBoard]


class FrameExtractor:
    """按拆解文档抽帧、拼板并维护取帧台账。"""

    def __init__(
        self,
        *,
        client: httpx.AsyncClient,
        paths: ShotVideoPaths,
        objects: PublicObjectWriter,
    ) -> None:
        self._client = client
        self._paths = paths
        self._objects = objects

    async def shot_rows(
        self, files: FileStore, namespace: str, doc_path: str
    ) -> tuple[tuple[ShotSpan, ...], ...]:
        """解析文档中的镜头区间，失败时提供可修正的错误。"""

        stored = await files.read(namespace, doc_path)
        if stored is None:
            raise ModelRetry(f"参考视频拆解文档 {doc_path} 不存在，先对该视频调用 video_parser。")
        try:
            return parse_shot_rows(stored.content)
        except ShotParseError as exc:
            raise ModelRetry(
                f"参考视频拆解文档 {doc_path} 解析失败：{exc}。用 edit_file 就地把该时间码改成 "
                f"{SHOT_TIMECODE_SHAPE} 形状（只改时间码，不动正文）后重新调用；整份文档都读"
                f"不出时改为对该视频重新调用 video_parser。"
            ) from exc

    async def ledger(
        self,
        files: FileStore,
        namespace: str,
        *,
        video_url: str,
        rows: Sequence[Sequence[ShotSpan]],
    ) -> tuple[ExtractionLedger, bool]:
        """读取或重建取帧台账，并返回是否复用；持久化由调用方负责。"""

        try:
            async with fetched(
                self._client, video_url, max_bytes=MAX_VIDEO_BYTES, suffix=".mp4"
            ) as source:
                duration = await probe_duration_ms(source)
                _check_in_range(rows, duration_ms=duration)
                video_hash = await asyncio.to_thread(_sha256_file, source)
                key = extraction_key(
                    video_hash=video_hash, rows=rows, interval_ms=FRAME_INTERVAL_MS
                )
                document = await self.load(files, namespace, expected_key=key)
                if document is not None:
                    return document, True
                built = await self._build(source=source, key=key, rows=rows)
        except (MediaError, BoardError) as exc:
            raise ModelRetry(str(exc)) from exc
        except ObjectWriteFailed as exc:
            raise ModelRetry(
                f"图片没存进对象存储：{exc}。重新调用一次；已经存下的会直接复用，不重传。"
            ) from exc
        return built, False

    async def load(
        self, files: FileStore, namespace: str, *, expected_key: str | None
    ) -> ExtractionLedger | None:
        """读取取帧台账；形状不合、版本不符，或（给定 ``expected_key`` 时）key 不匹配、某块板的
        地址不是本系统按该 key 与板号发布的地址，一律视为不存在。

        板地址按 key 与板号重算后整串比对，复用时登记的只会是本系统发布的地址。
        ``expected_key`` 为 None 时只确认工作区里有一份合规的当前版本台账。"""

        stored = await files.read(namespace, EXTRACTION_PATH)
        if stored is None:
            return None
        try:
            document = ExtractionLedger.model_validate_json(stored.content)
        except ValidationError as exc:
            _logger.warning(
                "取帧台账形状不合，按不存在处理", namespace=namespace, errors=exc.error_count()
            )
            return None
        if document.extraction_version != EXTRACTION_VERSION:
            return None
        if expected_key is None:
            return document
        if document.extraction_key != expected_key:
            return None
        forged = [
            board.board
            for board in document.boards
            if board.url
            != self._objects.public_url(
                self._paths.shot_board(extraction_key=expected_key, index=board.board)
            )
        ]
        if forged:
            _logger.warning(
                "取帧台账板地址与产物不符，按不存在处理", namespace=namespace, boards=forged
            )
            return None
        return document

    async def _build(
        self,
        *,
        source: Path,
        key: str,
        rows: Sequence[Sequence[ShotSpan]],
    ) -> ExtractionLedger:
        """按固定间隔抽帧，按结构分组生成公开预览板与取帧台账。

        台账只存复用判定用的版本与 key，以及实际建成的板号与地址（复用时按 key 重算核对）。
        板上有哪几个镜头由调用方按 ``rows`` 现算——rows 是 key 的组成部分，命中复用时
        它与建账时逐字相同。"""

        with TemporaryDirectory(prefix="shot-video-frames-") as tmp:
            frames = await extract_frames(source, fps=1000 / FRAME_INTERVAL_MS, out_dir=Path(tmp))
            cell_aspect = await asyncio.to_thread(image_aspect, frames[0])
            sampled = sample_rows(rows, interval_ms=FRAME_INTERVAL_MS)
            boards: list[LedgerBoard] = []
            for index, cells in enumerate(sampled, start=1):
                in_range = [
                    cell for cell in cells if cell.src_ms // FRAME_INTERVAL_MS < len(frames)
                ]
                if not in_range:
                    continue
                geometry = await asyncio.to_thread(
                    board_geometry, len(in_range), cell_aspect=cell_aspect
                )
                image = await asyncio.to_thread(
                    compose_board,
                    [(cell.cell_id, frames[cell.src_ms // FRAME_INTERVAL_MS]) for cell in in_range],
                    geometry=geometry,
                )
                url = await self._objects.put_public_object(
                    object_key=self._paths.shot_board(extraction_key=key, index=index),
                    content=image,
                    content_type=_JPEG,
                )
                boards.append(LedgerBoard(board=index, url=url))
        return ExtractionLedger(
            extraction_version=EXTRACTION_VERSION, extraction_key=key, boards=boards
        )


def _check_in_range(rows: Sequence[Sequence[ShotSpan]], *, duration_ms: int) -> None:
    # 允许末镜头时间码因取整超出媒体时长 500 ms。
    out_of_range = [shot for row in rows for shot in row if shot.end_ms > duration_ms + 500]
    if out_of_range:
        ids = ", ".join(str(shot.shot_id) for shot in out_of_range)
        raise ModelRetry(
            f"镜头时间戳越界（视频时长 {duration_ms}ms）：镜头 {ids}。对着拆解文档核一遍，"
            "用 edit_file 就地改正后重新调用。"
        )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


__all__ = [
    "EXTRACTION_PATH",
    "EXTRACTION_VERSION",
    "ExtractionLedger",
    "FrameExtractor",
    "LedgerBoard",
]
