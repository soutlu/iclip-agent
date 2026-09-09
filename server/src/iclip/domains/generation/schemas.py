"""生成请求的 HTTP 与持久化类型定义。

两种生成各有自己的请求形状：视频照抄上游异步接口（snake_case），图片是本系统自己的
（camelCase）。持久化存的就是请求自己的字段名，读取时经 request_from_payload 重新校验，
非法数据直接报错。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from datetime import datetime
from typing import TYPE_CHECKING, Annotated, Any, ClassVar, Final, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    TypeAdapter,
    field_validator,
    model_validator,
)
from pydantic.alias_generators import to_camel

from iclip.common.errors import ValidationFailed
from iclip.domains.generation.shot_prompt import format_shot_prompt, image_indexes_of

if TYPE_CHECKING:  # 只为类型：真导入会和 models.py 成环
    from iclip.domains.generation.models import GenerationJob

GenerationKind = Literal["video", "image"]

KIND_VIDEO: Final = "video"
KIND_IMAGE: Final = "image"

IMAGE_ASPECT_RATIOS = Literal[
    "1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"
]
IMAGE_RESOLUTIONS = Literal["1k", "2k", "4k"]

IMAGE_MAX_REFERENCES: Final = 10
"""图像编辑接口的参考图上限。超了在提交之前就拒，不浪费一次付费调用。"""
MAX_PROMPT_CHARS: Final = 4000
MAX_REFERENCE_URLS: Final = 16
MAX_MODEL_CHARS: Final = 200
MAX_USER_NAME_CHARS: Final = 200

ORIGIN_FIELDS: Final = frozenset({"conversation_id", "shot_index", "task_id"})
"""归属字段：落表上自己的列，不进 ``request`` JSON。

它们不是发给 provider 的参数，而是「这一行属于谁」——按对话、需求单查生成记录要走索引，
藏在 JSON 里就只能全表扫。"""

NOT_FORWARDED_FIELDS: Final = ORIGIN_FIELDS | frozenset({"shot"})
"""发给上游时去掉的字段：归属字段是我们自己的；``shot`` 已经拼成 ``prompt``，上游只认正文。
``shot`` 与归属字段不同，它要留在 ``request`` JSON 里给前端回填，所以不能进 ORIGIN_FIELDS。"""


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class SnakeModel(BaseModel):
    """字段名原样：视频那一对端点是上游接口的镜像，不转 camelCase。"""

    model_config = ConfigDict(extra="forbid", frozen=True)


Prompt = Annotated[str, Field(min_length=1, max_length=MAX_PROMPT_CHARS)]
ModelName = Annotated[str, Field(min_length=1, max_length=MAX_MODEL_CHARS)]
UserName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_USER_NAME_CHARS)
]
"""上游对账用的归属标签。它不是身份，不参与授权；取值规则在 identity 的 resolve_user_name。"""

MediaUrls = Annotated[list[str], Field(max_length=MAX_REFERENCE_URLS)]
"""一串媒体 URL。只收 http(s)：这些地址会被 provider 拿去下载，放行 ``file://``
之类的 scheme 等于把服务端变成任意文件的读取入口。"""


def _http_only(urls: list[str]) -> list[str]:
    for index, url in enumerate(urls):
        if not url.startswith(("http://", "https://")):
            raise ValueError(f"[{index}] 必须是 http:// 或 https:// 地址")
    return urls


def _nonblank(text: str) -> str:
    """只拒全空白，不改写：正文里的空格与换行会原样进拼出来的提示词。"""

    if not text.strip():
        raise ValueError("不能是空白")
    return text


class VideoShotTimelineItemIn(SnakeModel):
    """镜头组里的一镜：多长、说什么、引了哪几张图。"""

    seconds: Annotated[float, Field(gt=0)]
    prompt: Annotated[str, Field(max_length=MAX_PROMPT_CHARS)]
    image_indexes: list[Annotated[int, Field(ge=1)]]
    """正文里 ``@ImageN`` 的编号，按首次出现顺序；与分镜交付物里的同名字段是同一份。"""

    _check_prompt = field_validator("prompt")(_nonblank)

    @model_validator(mode="after")
    def _indexes_follow_the_prompt(self) -> VideoShotTimelineItemIn:
        derived = image_indexes_of(self.prompt)
        if self.image_indexes != derived:
            raise ValueError(
                f"image_indexes {self.image_indexes} 与正文里 @Image 的出现顺序 {derived} 不一致"
            )
        return self


class VideoShotIn(SnakeModel):
    """结构化的镜头组：全局设定加逐镜时间线。发给模型的正文由服务端按 shot_prompt 的规则拼。"""

    global_settings: Annotated[str, Field(max_length=MAX_PROMPT_CHARS)]
    timeline: Annotated[list[VideoShotTimelineItemIn], Field(min_length=1)]

    _check_global_settings = field_validator("global_settings")(_nonblank)


def _check_image_references(shot: VideoShotIn, available: int) -> None:
    """``@ImageN`` 指的是 reference_image_urls 的第 N 张；编号越界说明图和正文对不上。"""

    texts = [("global_settings", shot.global_settings)]
    texts += [
        (f"timeline[{index}].prompt", item.prompt) for index, item in enumerate(shot.timeline)
    ]
    for where, text in texts:
        for number in image_indexes_of(text):
            if not 1 <= number <= available:
                raise ValueError(
                    f"shot.{where} 引用了 @Image{number}，但 reference_image_urls 只有 {available} 张"
                )


class VideoGenerationIn(SnakeModel):
    """一次视频生成的输入。字段照上游异步接口，外加三个归属字段与结构化的 ``shot``。

    只拦本系统能判的：模型在允许表里（受理层）、地址是 http(s)、秒数不小于 -1、``shot``
    自身对得上（图片引用不越界、编号与正文一致）。画幅、分辨率、时长范围、素材规格由上游
    按模型判，这里不复制一份。
    """

    kind: ClassVar[GenerationKind] = KIND_VIDEO

    model: ModelName
    """新请求只接受配置允许的视频模型。历史记录保留原模型字符串，读回时不套用当前允许表。"""
    prompt: Prompt | None = None
    """发给模型的正文。传了 ``shot`` 可以不传，由服务端拼出来；两个都传时必须一字不差。"""
    shot: VideoShotIn | None = None
    """结构化的镜头组。存进记录供前端回填，不发上游——上游只认拼好的 ``prompt``。"""
    user_name: UserName | None = None
    """替谁发的。HTTP 边界按主体定值（API key 必填、浏览器填登录名），受理时已经非空。"""
    reference_image_urls: MediaUrls = []
    reference_video_urls: MediaUrls = []
    reference_audio_urls: MediaUrls = []
    generate_audio: bool | None = None
    """不传就不转发，让上游用模型默认；显式 False 保持关闭。"""
    resolution: Annotated[str, Field(min_length=1, max_length=50)] | None = None
    aspect_ratio: Annotated[str, Field(min_length=1, max_length=20)] | None = None
    seconds: Annotated[int, Field(ge=-1)] | None = None
    """``0`` 与 ``-1`` 的含义由上游定：默认时长、模型自定。"""
    provider_options: dict[str, Any] | None = None
    """各家私有参数的透传口，白名单由上游校验。"""

    conversation_id: uuid.UUID | None = None
    shot_index: Annotated[int, Field(ge=1)] | None = None
    task_id: uuid.UUID | None = None
    """需求单 id。只做归属与筛选，不校验它与对话的挂载关系。"""

    _check_urls = field_validator(
        "reference_image_urls", "reference_video_urls", "reference_audio_urls"
    )(_http_only)

    @model_validator(mode="after")
    def _assemble_prompt_from_shot(self) -> VideoGenerationIn:
        """持久化的记录里两者都在，读回时也走这里，所以规则是「至少一个、都给就得一致」。"""

        if self.shot is None:
            if self.prompt is None:
                raise ValueError("prompt 与 shot 至少传一个")
            return self
        _check_image_references(self.shot, len(self.reference_image_urls))
        assembled = format_shot_prompt(self.shot)
        if len(assembled) > MAX_PROMPT_CHARS:
            raise ValueError(
                f"shot 拼出的正文有 {len(assembled)} 字，超过 {MAX_PROMPT_CHARS} 字上限"
            )
        if self.prompt is not None and self.prompt != assembled:
            raise ValueError("prompt 与 shot 拼出的正文不一致，二者只传一个")
        # 模型是 frozen 的，校验器又不能换掉 self，派生字段只能这样填进去。
        object.__setattr__(self, "prompt", assembled)
        return self


class ImageGenerationIn(CamelModel):
    """一次图像生成的输入。参考图为空即文生图，否则走图像编辑。"""

    kind: ClassVar[GenerationKind] = KIND_IMAGE

    prompt: Prompt
    user_name: UserName | None = None
    """替谁发的。HTTP 边界按主体定值，工具从运行依赖取；受理时已经非空。"""
    model: ModelName | None = None
    """要哪家图片模型。省略时在受理阶段填入配置的默认模型。

    可选集合是装配表里那几家，不是一份枚举——运行配置声明接入了谁，能力清单端点照
    同一份声明对外说明。历史记录保留原模型字符串，读取持久化请求时不套用当前的选择策略。"""
    channel: Literal["dev", "pro"] | None = None
    """走哪个渠道。**只对声明了渠道轴的那几家有意义**，给别家会在受理阶段被拒。

    有渠道轴的那家两个渠道价钱不一样，所以这是调用方的决定，不是我们能替他换的；
    省略时受理阶段按那家声明的默认渠道填。"""
    aspect_ratio: IMAGE_ASPECT_RATIOS
    resolution: IMAGE_RESOLUTIONS = "1k"
    reference_image_urls: Annotated[list[str], Field(max_length=IMAGE_MAX_REFERENCES)] = []

    frame_number: int | None = Field(default=None, ge=1)
    """要顶替镜头组里的第几帧。服务端只当标签存着供筛选，不解析、不定位。"""

    conversation_id: uuid.UUID | None = None
    shot_index: Annotated[int, Field(ge=1)] | None = None
    task_id: uuid.UUID | None = None

    _check_urls = field_validator("reference_image_urls")(_http_only)


GenerationRequest = VideoGenerationIn | ImageGenerationIn

_ADAPTERS: Final = {
    KIND_VIDEO: TypeAdapter(VideoGenerationIn),
    KIND_IMAGE: TypeAdapter(ImageGenerationIn),
}


def request_to_payload(request: GenerationRequest) -> dict[str, Any]:
    """序列化成持久化 JSON：字段名照请求自己的（视频 snake_case、图片 camelCase），归属字段单独存列。"""

    return request.model_dump(by_alias=True, exclude=set(ORIGIN_FIELDS))


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

    只给调用方用得上的：图在哪、跑到哪一步、失败了给人看什么。provider 名称、原始
    快照、租约与各段时间戳都是排队与排障的内部机制，快照里还带着 provider 的签名
    URL；来源对话不写回去——查的时候本来就是按它查的。
    """

    id: uuid.UUID
    kind: str
    status: str
    request: dict[str, Any]
    shot_index: int | None
    task_id: uuid.UUID | None
    output_url: str | None
    watermark_output_url: str | None
    """视频的水印版地址；图片没有这一份，恒为空。"""
    error_message: str | None
    created_at: datetime


def generation_out(job: GenerationJob) -> GenerationOut:
    return GenerationOut(
        id=job.id,
        kind=job.kind,
        status=job.status,
        request=request_to_payload(job.request),
        shot_index=job.shot_index,
        task_id=job.task_id,
        output_url=job.output_url,
        watermark_output_url=job.watermark_output_url,
        error_message=job.error_message,
        created_at=job.created_at,
    )


class VideoSubmitOut(SnakeModel):
    """视频提交的回执，照上游：只有任务号。这里的 ``task_id`` 是我们这条生成记录的 id。"""

    task_id: uuid.UUID


class VideoTaskResult(SnakeModel):
    output_url: str
    watermark_output_url: str


class VideoTaskError(SnakeModel):
    code: str
    message: str


VideoTaskStatus = Literal["queued", "running", "succeeded", "failed"]

_TASK_STATUS: Final[Mapping[str, VideoTaskStatus]] = {
    "pending": "queued",
    "submitting": "running",
    "submitted": "running",
    "completed": "succeeded",
    "failed": "failed",
}
"""我们的记录状态到上游状态词。调用方拿现成的上游轮询代码就能用。"""


class VideoTaskOut(SnakeModel):
    """视频任务快照，照上游任务查询的形状。"""

    task_id: uuid.UUID
    type: Literal["video"] = "video"
    status: VideoTaskStatus
    result: VideoTaskResult | None = None
    """``status == "succeeded"`` 时必有。"""
    error: VideoTaskError | None = None
    """``status == "failed"`` 时必有。"""
    created_at: datetime


def video_task_out(job: GenerationJob) -> VideoTaskOut:
    status = _TASK_STATUS[job.status]
    result = None
    error = None
    if status == "succeeded":
        if job.output_url is None or job.watermark_output_url is None:
            # 完成态两个地址都该有（provider 那边缺一个就判失败），到这儿为空是持久化状态坏了。
            raise RuntimeError(f"视频记录 {job.id} 已完成却缺结果地址")
        result = VideoTaskResult(
            output_url=job.output_url, watermark_output_url=job.watermark_output_url
        )
    if status == "failed":
        if job.error_code is None or job.error_message is None:
            raise RuntimeError(f"视频记录 {job.id} 已失败却没有错误信息")
        error = VideoTaskError(code=job.error_code, message=job.error_message)
    return VideoTaskOut(
        task_id=job.id, status=status, result=result, error=error, created_at=job.created_at
    )


class VideoModelsOut(CamelModel):
    """接入了哪几个视频模型。只有模型 id，下拉直接显示它。"""

    default: str
    items: list[str]


class ImageModelOut(CamelModel):
    """一家图片模型对外声明的能力。调用方照它决定能填什么，受理层照同一份声明拦。"""

    model: str
    label: str
    aspect_ratios: tuple[str, ...]
    resolutions: tuple[str, ...]
    channels: tuple[str, ...]
    """空数组表示这家没有渠道这个轴，别给它传 ``channel``。"""


class ImageModelsOut(CamelModel):
    default: str
    """请求省略 ``model`` 时用的那家。"""

    items: list[ImageModelOut]


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
    "MAX_USER_NAME_CHARS",
    "NOT_FORWARDED_FIELDS",
    "ORIGIN_FIELDS",
    "GenerationEnvelope",
    "GenerationKind",
    "GenerationOut",
    "GenerationRequest",
    "GenerationsPageOut",
    "ImageGenerationIn",
    "ImageModelOut",
    "ImageModelsOut",
    "VideoGenerationIn",
    "VideoModelsOut",
    "VideoShotIn",
    "VideoShotTimelineItemIn",
    "VideoSubmitOut",
    "VideoTaskError",
    "VideoTaskOut",
    "VideoTaskResult",
    "VideoTaskStatus",
    "generation_out",
    "request_from_payload",
    "request_to_payload",
    "video_task_out",
]
