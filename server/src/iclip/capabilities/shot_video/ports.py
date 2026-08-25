"""能力包对外要的东西：三个窄协议，真身由组合根接上去。

不直接 import 生成域和 OSS——引一次，下一个能力包就照抄，围栏就破了。协议窄到
单测能手写替身。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Literal, Protocol, runtime_checkable

from pydantic_ai.tools import RunContext

from iclip.capabilities.workspace.store import WorkspaceStore
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


class PublicObjectWriter(Protocol):
    """把字节放到一个公网地址上。

    帧与切格产物必须外部取得到：它们要当参考图交给生成接口，而对方是自己去下载
    那个地址的。
    """

    async def put_public_object(self, *, object_key: str, content: bytes, content_type: str) -> str:
        """写入并返回公网 URL；同 key 已存在即复用。"""
        ...


class VideoUnderstanding(Protocol):
    """把一段视频交给多模态模型，拿回一份拆解文档。"""

    async def parse(self, video_url: str) -> str: ...


@runtime_checkable
class WorkspaceProvider(Protocol):
    """挂在同一个 agent 上、管着工作区的那个能力，长什么样。

    只声明要用到的两样：那份存储，和这次运行的命名空间。写成协议而不是认
    ``Workspace`` 这个类，是为了不把工作区能力的实现绑进来——``WorkspaceStore`` 本
    身就是一份纯协议，依赖它够了。
    """

    store: WorkspaceStore

    def resolve_scope(self, ctx: RunContext[Any]) -> str: ...


__all__ = [
    "ImageChannel",
    "ImageGenerations",
    "ImageJob",
    "ImageRequest",
    "InvalidImageRequest",
    "JobStatus",
    "PublicObjectWriter",
    "VideoUnderstanding",
    "WorkspaceProvider",
]
