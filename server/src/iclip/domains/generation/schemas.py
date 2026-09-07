"""生成请求的 HTTP 与持久化类型定义。

持久化使用 camelCase，读取时经 request_from_payload 重新校验，非法数据直接报错。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Annotated, Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator, model_validator
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


class GenerationOrigin(CamelModel):
    """这次生成是从哪儿发起的：哪段对话的哪个镜头组。

    **两个字段都落到表上自己的列，不进 ``request`` 那份 JSON。** 它们不是发给 provider
    的参数，而是「这一行属于谁」——按对话查生成记录要走索引，藏在 JSON 里就只能全表扫。
    """

    conversation_id: uuid.UUID | None = None
    shot_index: int | None = None


ORIGIN_FIELDS: Final = frozenset(GenerationOrigin.model_fields)
"""落列不落 JSON 的那几个字段名，``request_to_payload`` 按它排除。"""

MediaUrls = Annotated[list[str], Field(max_length=MAX_REFERENCE_URLS)]
"""一串媒体 URL。只收 http(s)：这些地址会被 provider 拿去下载，放行 ``file://``
之类的 scheme 等于把服务端变成任意文件的读取入口。"""


def _http_only(urls: list[str]) -> list[str]:
    for index, url in enumerate(urls):
        if not url.startswith(("http://", "https://")):
            raise ValueError(f"[{index}] 必须是 http:// 或 https:// 地址")
    return urls


class VideoGenerationIn(GenerationOrigin):
    """一次视频生成的输入。"""

    kind: Literal["video"] = KIND_VIDEO
    prompt: Prompt
    model: Annotated[str, Field(min_length=1, max_length=MAX_MODEL_CHARS)] | None = None
    """新请求只接受配置允许的视频模型；省略时在受理阶段填入默认模型。

    历史记录保留原模型字符串，读取持久化请求时不套用当前的模型选择策略。"""
    aspect_ratio: VIDEO_ASPECT_RATIOS
    duration_seconds: int = Field(ge=1, le=VIDEO_MAX_SECONDS)
    image_urls: MediaUrls = []
    """首帧/参考图。frozen 模型不会改这个列表，所以空列表当默认值是安全的。"""
    reference_video_urls: MediaUrls = []
    reference_audio_urls: MediaUrls = []
    generate_audio: bool | None = None
    """是否生成音频；未指定时使用供应商模型的默认值，显式 False 保持关闭。"""

    _check_urls = field_validator("image_urls", "reference_video_urls", "reference_audio_urls")(
        _http_only
    )


FrameEditId = Annotated[str, Field(min_length=1, max_length=100)]


class FrameEditPoint(CamelModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)


class FrameEditAnnotation(CamelModel):
    id: FrameEditId
    number: int = Field(ge=1, le=9999)
    kind: Literal["point", "rectangle", "ellipse", "arrow", "pen"]
    points: Annotated[list[FrameEditPoint], Field(min_length=1, max_length=2000)]

    @model_validator(mode="after")
    def check_geometry(self) -> FrameEditAnnotation:
        if self.kind == "point" and len(self.points) != 1:
            raise ValueError("点标注必须使用一个定位点")
        if self.kind == "pen" and len(self.points) < 2:
            raise ValueError("画笔必须使用至少两个点")
        if self.kind in {"rectangle", "ellipse", "arrow"} and len(self.points) != 2:
            raise ValueError("矩形、椭圆和箭头必须使用两个端点")
        return self


class FrameEditText(CamelModel):
    kind: Literal["text"]
    text: Annotated[str, Field(max_length=MAX_PROMPT_CHARS)]


class FrameEditAnnotationReference(CamelModel):
    kind: Literal["annotation"]
    id: FrameEditId


class FrameEditImageReference(CamelModel):
    kind: Literal["referenceImage"]
    id: FrameEditId


FrameEditInstruction = Annotated[
    FrameEditText | FrameEditAnnotationReference | FrameEditImageReference,
    Field(discriminator="kind"),
]


class FrameEditReference(CamelModel):
    id: FrameEditId
    url: Annotated[str, Field(min_length=1, max_length=4096)]
    kind: Literal["image", "annotated"]
    label: Annotated[str, Field(min_length=1, max_length=200)]

    @field_validator("url")
    @classmethod
    def check_url(cls, value: str) -> str:
        return _http_only([value])[0]


class FrameEditContext(CamelModel):
    """一次帧编辑的输入快照；图片顺序由用户确定，不由服务端补图。"""

    artifact_path: Annotated[str, Field(min_length=1, max_length=500)]
    frame_number: int = Field(ge=1)
    source_url: Annotated[str, Field(min_length=1, max_length=4096)]
    annotations: Annotated[list[FrameEditAnnotation], Field(max_length=50)] = []
    instructions: Annotated[list[FrameEditInstruction], Field(min_length=1, max_length=200)]
    references: Annotated[list[FrameEditReference], Field(min_length=1, max_length=10)]

    @field_validator("source_url")
    @classmethod
    def check_url(cls, value: str) -> str:
        return _http_only([value])[0]

    @model_validator(mode="after")
    def check_references(self) -> FrameEditContext:
        annotation_ids = {item.id for item in self.annotations}
        reference_ids = {item.id for item in self.references}
        if len(annotation_ids) != len(self.annotations) or len(reference_ids) != len(
            self.references
        ):
            raise ValueError("标注和参考图的 ID 必须各自唯一")
        if len({item.number for item in self.annotations}) != len(self.annotations):
            raise ValueError("标注编号必须唯一")
        if sum(len(item.points) for item in self.annotations) > 10000:
            raise ValueError("标注总点数不能超过 10000")
        annotated_count = sum(item.kind == "annotated" for item in self.references)
        if annotated_count > 1:
            raise ValueError("最多选择一张标注图")
        for part in self.instructions:
            if part.kind == "annotation" and (part.id not in annotation_ids or not annotated_count):
                raise ValueError("标注引用必须存在，并在图片列表中选择标注图")
            if part.kind == "referenceImage" and part.id not in reference_ids:
                raise ValueError("参考图引用已失效")
        return self

    def compile_prompt(self) -> str:
        """把稳定引用 ID 解析为本次图片顺序，保留用户输入的文字。"""

        indices = {item.id: index for index, item in enumerate(self.references, start=1)}
        annotations = {item.id: item.number for item in self.annotations}
        annotated_index = next(
            (indices[item.id] for item in self.references if item.kind == "annotated"), None
        )
        parts: list[str] = []
        for part in self.instructions:
            if part.kind == "text":
                parts.append(part.text)
            elif part.kind == "referenceImage":
                parts.append(f"【输入图片 {indices[part.id]}】")
            else:
                parts.append(f"【输入图片 {annotated_index} 中的标注 {annotations[part.id]}】")
        prompt = "".join(parts)
        if not prompt.strip():
            raise ValueError("修改要求不能为空")
        if annotated_index is not None:
            prompt += (
                f"\n输入图片 {annotated_index} 中的编号、线条和圈选仅表示修改位置；"
                "输出干净的编辑图片，不保留这些标注。"
            )
        if len(prompt) > MAX_PROMPT_CHARS:
            raise ValueError(f"编译后的修改要求不能超过 {MAX_PROMPT_CHARS} 字符")
        return prompt


class ImageGenerationIn(GenerationOrigin):
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

    frame_edit: FrameEditContext | None = None

    _check_urls = field_validator("reference_image_urls")(_http_only)

    @model_validator(mode="after")
    def check_frame_edit(self) -> ImageGenerationIn:
        if self.frame_edit is not None:
            if [item.url for item in self.frame_edit.references] != self.reference_image_urls:
                raise ValueError("参考图顺序必须与 frameEdit.references 一致")
            self.frame_edit.compile_prompt()
        return self


GenerationRequest = VideoGenerationIn | ImageGenerationIn

GenerationIn = Annotated[GenerationRequest, Field(discriminator="kind")]
"""HTTP 请求体。按 ``kind`` 分派——判别式联合让「视频请求带了 resolution」这种错
落在字段上报出来，而不是被某一支悄悄忽略。"""

_ADAPTERS: Final = {
    KIND_VIDEO: TypeAdapter(VideoGenerationIn),
    KIND_IMAGE: TypeAdapter(ImageGenerationIn),
}


def request_to_payload(request: GenerationRequest) -> dict[str, Any]:
    """序列化为 camelCase JSON；来源字段单独存列，不重复写入 request。"""

    return request.model_dump(by_alias=True, exclude={"kind", *ORIGIN_FIELDS})


def request_from_payload(kind: str, payload: dict[str, Any]) -> GenerationRequest:
    """按独立存列的 kind 选择适配器并校验持久化请求，非法数据直接报错。"""

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
    conversation_id: uuid.UUID | None
    """这次生成属于哪段对话，从表上的列来（不在 ``request`` 里，见 ``GenerationOrigin``）。"""
    shot_index: int | None
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
        conversation_id=job.conversation_id,
        shot_index=job.shot_index,
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
    "ORIGIN_FIELDS",
    "VIDEO_MAX_SECONDS",
    "GenerationEnvelope",
    "GenerationIn",
    "GenerationOrigin",
    "GenerationOut",
    "GenerationRequest",
    "GenerationsPageOut",
    "ImageGenerationIn",
    "VideoGenerationIn",
    "generation_out",
    "request_from_payload",
    "request_to_payload",
]
