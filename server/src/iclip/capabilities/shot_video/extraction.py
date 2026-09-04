"""拆解文档与取帧账本：文档落在工作区的哪、镜头时间码怎么读出来、整片怎么抽帧拼板成账本。"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections.abc import Sequence
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Final

import httpx
from pydantic_ai import ModelRetry

from iclip.capabilities.shot_video import ffmpeg
from iclip.capabilities.shot_video.board import (
    BoardError,
    board_geometry,
    compose_board,
    image_aspect,
)
from iclip.capabilities.shot_video.parser import VideoUnderstandingError
from iclip.capabilities.shot_video.ports import (
    ObjectWriteFailed,
    PublicObjectWriter,
    ShotVideoPaths,
    VideoUnderstanding,
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

EXTRACTION_PATH: Final = "frames/extraction.json"
EXTRACTION_VERSION: Final = 1

_JPEG: Final = "image/jpeg"
_DOC_DIR: Final = "video"

_UNSAFE_STEM = re.compile(r"[^A-Za-z0-9_-]+")
_STEM_CHARS: Final = 40


def video_doc_path(video_url: str) -> str:
    """拆解文档在工作区里的路径。

    纯由 URL 算出，所以拆片和取帧两件工具各算各的也落在同一份文件上。带哈希后缀是
    因为两段不同的视频完全可能同名。
    """

    stem = _UNSAFE_STEM.sub("-", video_url.rsplit("/", 1)[-1].rsplit(".", 1)[0]).strip("-")
    digest = hashlib.sha256(video_url.encode("utf-8")).hexdigest()[:8]
    return f"{_DOC_DIR}/{(stem[:_STEM_CHARS] or 'video')}-{digest}.md"


class FrameExtractor:
    """拆片与取帧这一段：调拆解接口、读镜头时间码、按秒抽帧拼板、读写取帧账本。"""

    def __init__(
        self,
        *,
        understanding: VideoUnderstanding,
        client: httpx.AsyncClient,
        paths: ShotVideoPaths,
        objects: PublicObjectWriter,
    ) -> None:
        self._understanding = understanding
        self._client = client
        self._paths = paths
        self._objects = objects

    async def parse(self, video_url: str) -> str:
        """拆解一段视频，返回文档正文。"""

        try:
            return await self._understanding.parse(video_url)
        except VideoUnderstandingError as exc:
            raise ModelRetry(f"这段视频没拆解成功：{exc}") from exc

    async def shot_rows(
        self, files: FileStore, namespace: str, doc_path: str
    ) -> tuple[tuple[ShotSpan, ...], ...]:
        """从拆解文档读逐镜时间区间；读不出就给出一条模型能自己走的修复路径。"""

        stored = await files.read(namespace, doc_path)
        if stored is None:
            raise ModelRetry(
                f"参考视频拆解文档 {doc_path} 不存在，先对该视频调用 video_parser_md。"
            )
        try:
            return parse_shot_rows(stored.content)
        except ShotParseError as exc:
            raise ModelRetry(
                f"参考视频拆解文档 {doc_path} 解析失败：{exc}。用 edit_file 就地把该时间码改成 "
                f"{SHOT_TIMECODE_SHAPE} 形状（只改时间码，不动正文）后重新调用；整份文档都读"
                f"不出时改为对该视频重新调用 video_parser_md。"
            ) from exc

    async def ledger(
        self,
        files: FileStore,
        namespace: str,
        *,
        video_url: str,
        rows: Sequence[Sequence[ShotSpan]],
    ) -> tuple[dict[str, Any], bool]:
        """取回或重建取帧账本；第二个返回值是「复用了既有那份」。账本本身不落盘，由调用方写。"""

        try:
            async with ffmpeg.fetched(
                self._client, video_url, max_bytes=ffmpeg.MAX_VIDEO_BYTES, suffix=".mp4"
            ) as source:
                duration = await ffmpeg.probe_duration_ms(source)
                _check_in_range(rows, duration_ms=duration)
                video_hash = await asyncio.to_thread(_sha256_file, source)
                key = extraction_key(
                    video_hash=video_hash, rows=rows, interval_ms=FRAME_INTERVAL_MS
                )
                document = await self.load(files, namespace, expected_key=key)
                if document is not None:
                    return document, True
                built = await self._build(
                    source=source,
                    key=key,
                    video_url=video_url,
                    video_hash=video_hash,
                    rows=rows,
                )
        except (ffmpeg.MediaError, BoardError) as exc:
            raise ModelRetry(str(exc)) from exc
        except ObjectWriteFailed as exc:
            raise ModelRetry(
                f"候选帧预览板没存进对象存储：{exc}。重新调用一次；已经存下的板会直接复用，不重传。"
            ) from exc
        return built, False

    async def load(
        self, files: FileStore, namespace: str, *, expected_key: str | None
    ) -> dict[str, Any] | None:
        """读取帧账本；版本不符或（给定时）key 不匹配一律视为不存在。"""

        stored = await files.read(namespace, EXTRACTION_PATH)
        if stored is None:
            return None
        try:
            document = json.loads(stored.content)
        except json.JSONDecodeError:
            return None
        if not isinstance(document, dict):
            return None
        if document.get("extractionVersion") != EXTRACTION_VERSION:
            return None
        if expected_key is not None and document.get("extractionKey") != expected_key:
            return None
        return document

    async def _build(
        self,
        *,
        source: Path,
        key: str,
        video_url: str,
        video_hash: str,
        rows: Sequence[Sequence[ShotSpan]],
    ) -> dict[str, Any]:
        """整片按秒抽帧、逐结构层级拼板落公开地址，产出取帧账本。"""

        with TemporaryDirectory(prefix="shot-video-frames-") as tmp:
            frames = await ffmpeg.extract_frames(
                source, fps=1000 / FRAME_INTERVAL_MS, out_dir=Path(tmp)
            )
            cell_aspect = await asyncio.to_thread(image_aspect, frames[0])
            sampled = sample_rows(rows, interval_ms=FRAME_INTERVAL_MS)
            boards: list[dict[str, Any]] = []
            for index, (row, cells) in enumerate(zip(rows, sampled, strict=True), start=1):
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
                boards.append(
                    {
                        "board": index,
                        "url": url,
                        "shots": sorted({shot.shot_id for shot in row}),
                        "layout": f"{geometry.cols}x{geometry.rows}",
                        "cells": [
                            {"id": cell.cell_id, "shotId": cell.shot_id} for cell in in_range
                        ],
                    }
                )
        covered = {cell["shotId"] for board in boards for cell in board["cells"]}
        return {
            "extractionVersion": EXTRACTION_VERSION,
            "extractionKey": key,
            "intervalMs": FRAME_INTERVAL_MS,
            "video": {"url": video_url, "contentHash": f"sha256:{video_hash}"},
            "boards": boards,
            "shotsWithoutCells": sorted(
                shot.shot_id for row in rows for shot in row if shot.shot_id not in covered
            ),
        }


def _check_in_range(rows: Sequence[Sequence[ShotSpan]], *, duration_ms: int) -> None:
    # 容 500ms：拆解文档的末镜头终点常常写到时长那一刻的取整之外。
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
    "FrameExtractor",
    "video_doc_path",
]
