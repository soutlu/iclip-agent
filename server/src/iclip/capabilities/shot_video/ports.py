"""镜头能力的外部依赖协议，由组合根适配领域服务与对象存储。文件存储复用平台 FileStore。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Literal, Protocol

from iclip.domains.identity.public import Principal

ImageChannel = Literal["dev", "pro"]

JobStatus = Literal["pending", "submitting", "submitted", "completed", "failed"]


class InvalidImageRequest(ValueError):
    """生成请求校验失败，由工具转换为模型可修正的错误。"""


@dataclass(frozen=True, slots=True)
class ImageRequest:
    """图像生成参数，取值由生成域统一校验。"""

    prompt: str
    aspect_ratio: str
    resolution: str
    channel: ImageChannel
    reference_image_urls: tuple[str, ...] = ()
    conversation_id: str | None = None
    """生成来源对话 id，由生成域校验并持久化。"""


@dataclass(frozen=True, slots=True)
class ImageJob:
    """生成进度快照，保留原始错误码供调用方判断。"""

    job_id: uuid.UUID
    status: JobStatus
    channel: ImageChannel
    output_url: str | None = None
    error_code: str | None = None
    error_message: str | None = None

    @property
    def finished(self) -> bool:
        return self.status in ("completed", "failed")


class ImageGenerations(Protocol):
    """图像生成提交与状态查询协议。"""

    async def submit(self, principal: Principal, request: ImageRequest) -> ImageJob:
        """受理生成并返回任务记录；实际 Provider 调用由后台执行。"""
        ...

    async def get(self, principal: Principal, job_id: uuid.UUID) -> ImageJob: ...


class ObjectWriteFailed(Exception):
    """对象存储写入失败，由组合根转换为能力协议错误，供工具报告结果。"""


class PublicObjectWriter(Protocol):
    """写入可公开访问的对象，供外部生成接口下载参考图。"""

    async def put_public_object(self, *, object_key: str, content: bytes, content_type: str) -> str:
        """写入并返回公网 URL；同 key 已存在即复用。存不下来抛 ``ObjectWriteFailed``。"""
        ...


class ShotVideoPaths(Protocol):
    """公开对象路径协议，布局由平台层定义并经组合根注入。"""

    def shot_board(self, *, extraction_key: str, index: int) -> str:
        """取帧预览板。"""
        ...

    def shot_cell(self, *, job_id: uuid.UUID, cell_id: str) -> str:
        """出图整图切出来的一格。"""
        ...

    def anchor_sheet(self, *, job_id: uuid.UUID, index: int) -> str:
        """补拍设定图切出来的一格。"""
        ...


class VideoUnderstanding(Protocol):
    """把一段视频交给多模态模型，拿回一份拆解文档。"""

    async def parse(self, video_url: str) -> str: ...


__all__ = [
    "ImageChannel",
    "ImageGenerations",
    "ImageJob",
    "ImageRequest",
    "InvalidImageRequest",
    "JobStatus",
    "ObjectWriteFailed",
    "PublicObjectWriter",
    "ShotVideoPaths",
    "VideoUnderstanding",
]
