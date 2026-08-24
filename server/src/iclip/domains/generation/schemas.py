"""生成请求的类型：既是对外的 wire 形状，也是入库的形状。

**只有一套定义。** 字段有哪些、画幅取哪几个值、参考图最多几张，全在这里由 pydantic
判一次；不再另写一份手工校验。这样「HTTP 进得来的东西」和「从库里读回来的东西」走
的是同一条路，不会出现一边合法一边不合法。

入库存 ``model_dump(by_alias=True)``（camelCase），读回来用 ``request_from_payload``
重新校验一遍——库里的行可能是几分钟前另一个进程写的，形状坏了要响亮失败，不降级。
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Annotated, Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator
from pydantic.alias_generators import to_camel

from iclip.common.errors import ValidationFailed

if TYPE_CHECKING:  # 只为类型：真导入会和 models.py 成环
    from iclip.domains.generation.models import GenerationJob

KIND_VIDEO: Final = "video"
KIND_IMAGE: Final = "image"

VIDEO_ASPECT_RATIOS = Literal["1:1", "3:4", "4:3", "9:16", "16:9", "21:9"]
IMAGE_ASPECT_RATIOS = Literal[
    "1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"
]
IMAGE_RESOLUTIONS = Literal["1k", "2k", "4k"]

VIDEO_MAX_SECONDS: Final = 60
IMAGE_MAX_REFERENCES: Final = 10
"""图像编辑接口的参考图上限。超了在提交之前就拒，不浪费一次付费调用。"""
MAX_PROMPT_CHARS: Final = 4000
MAX_REFERENCE_URLS: Final = 16
MAX_MODEL_CHARS: Final = 200


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


Prompt = Annotated[str, Field(min_length=1, max_length=MAX_PROMPT_CHARS)]

MediaUrls = Annotated[list[str], Field(max_length=MAX_REFERENCE_URLS)]
"""一串媒体 URL。只收 http(s)：这些地址会被 provider 拿去下载，放行 ``file://``
之类的 scheme 等于把服务端变成任意文件的读取入口。"""


def _http_only(urls: list[str]) -> list[str]:
    for index, url in enumerate(urls):
        if not url.startswith(("http://", "https://")):
            raise ValueError(f"[{index}] 必须是 http:// 或 https:// 地址")
    return urls


class VideoGenerationIn(CamelModel):
    """一次视频生成的输入。"""

    kind: Literal["video"] = KIND_VIDEO
    prompt: Prompt
    model: Annotated[str, Field(min_length=1, max_length=MAX_MODEL_CHARS)] | None = None
    """用对方哪个模型。不给就用配置里的默认模型。

    刻意**不在本仓维护一张可选模型白名单**：能用哪些模型是对方说了算的，白名单只会
    过期；名字写错的后果是这一行带着对方自己的拒绝理由失败，看得见、查得清。"""
    aspect_ratio: VIDEO_ASPECT_RATIOS
    duration_seconds: int = Field(ge=1, le=VIDEO_MAX_SECONDS)
    image_urls: MediaUrls = []
    """首帧/参考图。frozen 模型不会改这个列表，所以空列表当默认值是安全的。"""
    reference_video_urls: MediaUrls = []
    reference_audio_urls: MediaUrls = []

    _check_urls = field_validator("image_urls", "reference_video_urls", "reference_audio_urls")(
        _http_only
    )


class ImageGenerationIn(CamelModel):
    """一次图像生成的输入。参考图为空即文生图，否则走图像编辑。"""

    kind: Literal["image"] = KIND_IMAGE
    prompt: Prompt
    channel: Literal["dev", "pro"] = "dev"
    """走哪个渠道。

    图片这家的**模型是写死在接口地址里的**（那个地址整条来自环境变量），今天真正可
    选的就是这个渠道。所以图片暴露 ``channel``、视频暴露 ``model``——各自照对方
    真实的那个轴来，不硬凑成一个统一字段。

    两个渠道价钱不一样，所以这是调用方的决定，不是我们能替他换的。"""
    aspect_ratio: IMAGE_ASPECT_RATIOS
    resolution: IMAGE_RESOLUTIONS = "1k"
    reference_image_urls: Annotated[list[str], Field(max_length=IMAGE_MAX_REFERENCES)] = []

    _check_urls = field_validator("reference_image_urls")(_http_only)


GenerationRequest = VideoGenerationIn | ImageGenerationIn

GenerationIn = Annotated[GenerationRequest, Field(discriminator="kind")]
"""HTTP 请求体。按 ``kind`` 分派——判别式联合让「视频请求带了 resolution」这种错
落在字段上报出来，而不是被某一支悄悄忽略。"""

_ADAPTERS: Final = {
    KIND_VIDEO: TypeAdapter(VideoGenerationIn),
    KIND_IMAGE: TypeAdapter(ImageGenerationIn),
}


def request_to_payload(request: GenerationRequest) -> dict[str, Any]:
    """转成入库的 JSON 形状（camelCase，与对外一致）。"""

    return request.model_dump(by_alias=True, exclude={"kind"})


def request_from_payload(kind: str, payload: dict[str, Any]) -> GenerationRequest:
    """从入库形状还原请求，形状坏了就响亮失败。

    按 ``kind`` 挑适配器，不走判别式联合：``kind`` 是表上的一列，不在 JSON 里，联合
    没有判别字段可读。
    """

    adapter = _ADAPTERS.get(kind)
    if adapter is None:
        raise ValidationFailed(f"未知的生成类型: {kind}")
    try:
        return adapter.validate_python(payload)
    except ValueError as exc:
        raise ValidationFailed(f"生成请求的形状不合法: {exc}") from exc


class GenerationOut(CamelModel):
    """一次生成对外的样子。

    刻意不含 provider 的原始快照、租约与尝试次数：那些是排队与排障的内部机制，
    对调用方没有意义，而快照里还带着 provider 的签名 URL。
    """

    id: uuid.UUID
    kind: str
    provider: str
    status: str
    request: dict[str, Any]
    output_url: str | None
    provider_status: str | None
    error_code: str | None
    error_message: str | None
    created_at: datetime
    updated_at: datetime
    submitted_at: datetime | None
    finished_at: datetime | None


def generation_out(job: GenerationJob) -> GenerationOut:
    return GenerationOut(
        id=job.id,
        kind=job.kind,
        provider=job.provider,
        status=job.status,
        request=request_to_payload(job.request),
        output_url=job.output_url,
        provider_status=job.provider_status,
        error_code=job.error_code,
        error_message=job.error_message,
        created_at=job.created_at,
        updated_at=job.updated_at,
        submitted_at=job.submitted_at,
        finished_at=job.finished_at,
    )


class GenerationEnvelope(CamelModel):
    generation: GenerationOut


class GenerationsPageOut(CamelModel):
    items: list[GenerationOut]


__all__ = [
    "IMAGE_MAX_REFERENCES",
    "KIND_IMAGE",
    "KIND_VIDEO",
    "MAX_MODEL_CHARS",
    "MAX_PROMPT_CHARS",
    "MAX_REFERENCE_URLS",
    "VIDEO_MAX_SECONDS",
    "GenerationEnvelope",
    "GenerationIn",
    "GenerationOut",
    "GenerationRequest",
    "GenerationsPageOut",
    "ImageGenerationIn",
    "VideoGenerationIn",
    "generation_out",
    "request_from_payload",
    "request_to_payload",
]
