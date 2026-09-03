"""能力包对外要的东西：三个窄协议，真身由组合根接上去。

不直接 import 生成域和 OSS——引一次，下一个能力包就照抄，围栏就破了。协议窄到
单测能手写替身。文件存储不在这里另写一份：那是平台层的 ``FileStore`` 协议，和
工作区能力用的是同一份。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Literal, Protocol

from iclip.domains.identity.public import Principal

ImageChannel = Literal["dev", "pro"]

JobStatus = Literal["pending", "submitting", "submitted", "completed", "failed"]


class InvalidImageRequest(ValueError):
    """出图参数不合生成域那套请求定义。

    不复用领域错误：那一套会被 HTTP 处理器映射成状态码，而这条路上没有等在线上
    的请求——它的去处是翻成一句让模型自己改的提示。
    """


@dataclass(frozen=True, slots=True)
class ImageRequest:
    """一次图片生成要的参数。取值校验归生成域那套唯一定义，这里不再写一遍。"""

    prompt: str
    aspect_ratio: str
    resolution: str
    channel: ImageChannel
    reference_image_urls: tuple[str, ...] = ()
    conversation_id: str | None = None
    """这次出图属于哪段对话，落在生成记录上（界面按它把出图归到对话下面）。

    本包不认识对话那张表，所以只当一个字符串带过去，认不认得出由生成域判。"""


@dataclass(frozen=True, slots=True)
class ImageJob:
    """一次生成走到哪了。``error_code`` 原样带出来：它是能不能自动重发的唯一依据。"""

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
    """提交一次图片生成，以及查它走到哪了。"""

    async def submit(self, principal: Principal, request: ImageRequest) -> ImageJob:
        """受理一次生成，返回刚落下的那一行；真正去调对方是后台的事。"""
        ...

    async def get(self, principal: Principal, job_id: uuid.UUID) -> ImageJob: ...


class ObjectWriteFailed(Exception):
    """对象存储没把这份字节存下来（那一侧已经重试过了）。

    平台层有自己的异常，但本包不认识它（见模块 docstring），由组合根的适配器翻成这
    个。工具认得它，才能把「没存下来」写进工具结果，而不是让它穿出工具打死整次运行。
    """


class PublicObjectWriter(Protocol):
    """把字节放到一个公网地址上。

    帧与切格产物必须外部取得到：它们要当参考图交给生成接口，而对方是自己去下载
    那个地址的。
    """

    async def put_public_object(self, *, object_key: str, content: bytes, content_type: str) -> str:
        """写入并返回公网 URL；同 key 已存在即复用。存不下来抛 ``ObjectWriteFailed``。"""
        ...


class ShotVideoPaths(Protocol):
    """这项能力的产物在公开桶里落在哪。

    本能力不自己拼 key：桶里的布局是平台那一侧的事实源，组合根把它递进来。
    """

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
