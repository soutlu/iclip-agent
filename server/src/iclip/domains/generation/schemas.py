"""生成请求的 HTTP 与持久化类型定义。

落库的请求有三种形状：视频（出片与编辑段）照抄上游异步接口（snake_case），图片与合成是本系统
自己的（camelCase）。持久化存的就是请求自己的字段名，读取时按 (kind, operation) 经
request_from_payload 重新校验，非法数据直接报错。编辑段与合成的受理输入另有自己的类型，受理时
换成落库的那一种。切图与上传没有请求。"""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping
from datetime import datetime
from typing import TYPE_CHECKING, Annotated, Any, ClassVar, Final, Literal, get_args, overload

from pydantic import (
    AfterValidator,
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
from iclip.common.generation_vocab import GenerationKind, GenerationOperation, GenerationStatus
from iclip.common.shot_prompt import format_seconds, format_shot_prompt
from iclip.common.shot_rules import (
    MAX_REFERENCE_IMAGES,
    first_unavailable_image,
    image_indexes_of,
    timeline_fault,
)
from iclip.common.urls import is_http_url

if TYPE_CHECKING:  # 只为类型：真导入会和 models.py 成环
    from iclip.domains.generation.models import GenerationJob

# 两套词表写在 common（推送帧也要引），这里照原名导出。状态常量放这里而不是 models.py：
# GenerationOut 运行时要解析状态词，本模块的投影要按它判断，而 models.py 反过来导入本模块。
STATUS_PENDING: Final = "pending"
"""已受理，尚未提交给 Provider。"""
STATUS_SUBMITTING: Final = "submitting"
"""提交中断时禁止自动重投，避免重复计费；恢复规则见 queue.py。"""
STATUS_SUBMITTED: Final = "submitted"
"""Provider 已接受任务，等待结果。"""
STATUS_COMPLETED: Final = "completed"
STATUS_FAILED: Final = "failed"

KIND_VIDEO: Final = "video"
KIND_IMAGE: Final = "image"

OPERATION_GENERATE: Final = "generate"
"""调模型：出片、编辑段、图片生成都是它。"""
OPERATION_COMPOSE: Final = "compose"
"""本地拼接：合成出一条新的成片，不经外部服务。"""
OPERATION_CUT: Final = "cut"
"""本地切图：从一张宫格上切出来的一格，来源是那张宫格。创建即完成，没有请求。"""
OPERATION_UPLOAD: Final = "upload"
"""用户上传：确认过的一次直传，没有来源、不挂对话。创建即完成，没有请求。"""

ClipStage = Literal["fetching", "processing", "uploading"]
"""本地加工（合成、编辑段提交上游前的切片）在途时跑到哪一步，加工时上报，落在 provider_status 上。

排队由 ``status == "pending"`` 表达，终态由 status 表达，都不另给词。切参考片段没有取素材
这一步——它是边读边切的。"""

CLIP_FETCHING: Final = "fetching"
"""取素材：下载各段的源，以及探它们的规格。"""
CLIP_PROCESSING: Final = "processing"
"""加工：切一段，或者拼起来重编码。"""
CLIP_UPLOADING: Final = "uploading"
"""上传：把产物交给对象存储。"""

CLIP_STAGES: Final[tuple[ClipStage, ...]] = get_args(ClipStage)
"""能对外露出的阶段词。列里出现别的值就当没有，不把任意 provider 状态转给调用方。"""

IMAGE_ASPECT_RATIOS = Literal[
    "1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"
]
IMAGE_RESOLUTIONS = Literal["1k", "2k", "4k"]

IMAGE_MAX_REFERENCES: Final = 10
"""图像编辑接口的参考图上限。超了在提交之前就拒，不浪费一次付费调用。"""
MAX_PROMPT_CHARS: Final = 4000
MAX_REFERENCE_URLS: Final = MAX_REFERENCE_IMAGES
"""每类参考素材最多几个地址，取一组镜头的帧图上限：分镜文件里存得下的一组，出片就必须发得出去。"""
MAX_MODEL_CHARS: Final = 200
MAX_USER_NAME_CHARS: Final = 200
MAX_METADATA_CHARS: Final = 2000
"""``metadata`` 序列化后的长度上限：它是调用方的坐标标签，不是存东西的地方。"""
MAX_URL_CHARS: Final = 2000
"""服务端要拿去下载的单个地址的长度上限。"""

ORIGIN_FIELDS: Final = frozenset(
    {"conversation_id", "task_id", "metadata", "shot_index", "source_url"}
)
"""归属字段：落表上自己的列，不进 ``request`` JSON。

它们不是发给 provider 的参数，而是「这一行属于谁、为谁出的」：对话与需求单按索引查；视频的
镜头组编号落 ``shot_index`` 列；``metadata`` 是调用方自己的键，服务端不读不写、原样存、按包含
匹配筛。帧图编辑的 ``source_url``（底图地址）是请求字段，受理时解析成来源；其余来源、原作与
区间也落列，但不是请求字段，由服务端按基底定。"""

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
        if not is_http_url(url):
            raise ValueError(f"[{index}] 必须是 http:// 或 https:// 地址")
    return urls


def _bounded_metadata(value: dict[str, Any]) -> dict[str, Any]:
    if len(json.dumps(value, ensure_ascii=False, default=str)) > MAX_METADATA_CHARS:
        raise ValueError(f"metadata 序列化后不能超过 {MAX_METADATA_CHARS} 字符")
    return value


Metadata = Annotated[dict[str, Any], AfterValidator(_bounded_metadata)]
"""调用方自己的键，形状归调用方定（分镜页给图片记 ``{"shot", "frame"}``）；服务端不读不写、
不校验，只拦超长。视频的镜号在 ``shot_index``，不在这里。"""


def _nonblank(text: str) -> str:
    """只拒全空白，不改写：正文里的空格与换行会原样进拼出来的提示词。"""

    if not text.strip():
        raise ValueError("不能是空白")
    return text


Seconds = Annotated[float, Field(ge=0)]


class VideoShotTimelineItemIn(SnakeModel):
    """镜头组里的一镜：起止时间、说什么、引了哪几张图。与分镜文件 video_shot.json 里的一镜同形。"""

    timestamps: tuple[Seconds, Seconds]
    """``[开始秒, 结束秒]``，正文里的镜头标记直接用它，不重算。"""
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
    """结构化的镜头组：全局设定加逐镜时间线。发给模型的正文由服务端按 common.shot_prompt 的规则拼。"""

    global_settings: Annotated[str, Field(max_length=MAX_PROMPT_CHARS)]
    timeline: Annotated[list[VideoShotTimelineItemIn], Field(min_length=1)]

    _check_global_settings = field_validator("global_settings")(_nonblank)

    @model_validator(mode="after")
    def _timeline_runs_forward(self) -> VideoShotIn:
        """与分镜交付同一套规则：第一镜从 0 起，每镜结束晚于开始，各镜按先后排、不重叠。"""

        previous_end = 0.0
        for position, item in enumerate(self.timeline, start=1):
            start, end = item.timestamps
            match timeline_fault(position, start, end, previous_end):
                case "not_after_start":
                    raise ValueError(
                        f"第 {position} 镜的 timestamps 为 [{format_seconds(start)}, "
                        f"{format_seconds(end)}]，结束必须晚于开始"
                    )
                case "first_not_at_zero":
                    raise ValueError(f"第一镜从 {format_seconds(start)} 秒开始，必须从 0 开始")
                case "overlaps_previous":
                    raise ValueError(
                        f"第 {position} 镜从 {format_seconds(start)} 秒开始，"
                        f"早于上一镜的结束 {format_seconds(previous_end)} 秒"
                    )
                case None:
                    previous_end = end
        return self


def _check_image_references(shot: VideoShotIn, available: int) -> None:
    """``@ImageN`` 指的是 reference_image_urls 的第 N 张；编号越界说明图和正文对不上。"""

    texts = [("global_settings", shot.global_settings)]
    texts += [
        (f"timeline[{index}].prompt", item.prompt) for index, item in enumerate(shot.timeline)
    ]
    for where, text in texts:
        number = first_unavailable_image(text, available)
        if number is not None:
            raise ValueError(
                f"shot.{where} 引用了 @Image{number}，但 reference_image_urls 只有 {available} 张"
            )


class VideoGenerationIn(SnakeModel):
    """一次视频生成的输入。字段照上游异步接口，外加归属字段、坐标 ``metadata`` 与结构化的 ``shot``。

    只拦本系统能判的：模型在允许表里（受理层）、地址是 http(s)、秒数不小于 -1、``shot``
    自身对得上（图片引用不越界、编号与正文一致）。画幅、分辨率、时长范围、素材规格由上游
    按模型判，这里不复制一份。
    """

    kind: ClassVar[GenerationKind] = KIND_VIDEO
    operation: ClassVar[GenerationOperation] = OPERATION_GENERATE

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
    task_id: uuid.UUID | None = None
    """需求单 id。只做归属与筛选，不校验它与对话的挂载关系。"""
    metadata: Metadata | None = None
    shot_index: Annotated[int, Field(ge=1)] | None = None
    """镜头组编号，从 1 起。落记录自己的列，不进 ``request``、不发上游；不给就是一条没有镜号的出片。

    下界跟着分镜文件走：那里的 ``shots[].index`` 就是从 1 数的。收下 0 只会落一条读不出
    镜头组的记录——服务端不报错，分镜页永远不显示。"""

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
    operation: ClassVar[GenerationOperation] = OPERATION_GENERATE

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

    conversation_id: uuid.UUID | None = None
    task_id: uuid.UUID | None = None
    metadata: Metadata | None = None
    source_url: Annotated[str, Field(min_length=1, max_length=MAX_URL_CHARS)] | None = None
    """帧图编辑的底图地址：这次改的是哪张图。受理时按地址找库里的记录，找到记来源、找不到记外部
    地址；不进 ``request``、不发上游（底图要不要给模型看，由 ``referenceImageUrls`` 决定）。"""

    _check_urls = field_validator("reference_image_urls")(_http_only)

    @field_validator("source_url")
    @classmethod
    def _source_is_http(cls, url: str | None) -> str | None:
        if url is not None and not is_http_url(url):
            raise ValueError("必须是 http:// 或 https:// 地址")
        return url


class VideoEditIn(SnakeModel):
    """一次编辑段的受理输入：在一条成片上改 ``[range_start_ms, range_end_ms)`` 这一段。

    与出片同族，转发给上游的字段照上游命名。不收参考视频：服务端提交上游前按区间从基底上切
    一段交给模型。不收 ``shot`` 与原作：编辑段只有正文，原作由基底定。受理后落库的是一条
    ``VideoGenerationIn``，来源、原作与区间落列。"""

    source_job_id: uuid.UUID
    """基底：一条已完成的成片（出片或合成），这段对话自己的或继承来的。"""
    range_start_ms: Annotated[int, Field(ge=0)]
    range_end_ms: int
    """要改的那一段，毫秒。结束超出基底时长按基底时长截；起点落在基底之外，这次编辑判失败。"""
    model: ModelName
    prompt: Prompt
    user_name: UserName | None = None
    """规则同出片的 ``user_name``。"""
    reference_image_urls: MediaUrls = []
    seconds: Annotated[int, Field(ge=-1)] | None = None
    provider_options: dict[str, Any] | None = None

    conversation_id: uuid.UUID | None = None
    task_id: uuid.UUID | None = None
    metadata: Metadata | None = None

    _check_urls = field_validator("reference_image_urls")(_http_only)

    @model_validator(mode="after")
    def _end_after_start(self) -> VideoEditIn:
        if self.range_end_ms <= self.range_start_ms:
            raise ValueError("range_end_ms 必须大于 range_start_ms")
        return self


class VideoComposeIn(CamelModel):
    """一次合成的受理输入：只给编辑段，服务端按它的基底与实际区间算出前段、编辑段、后段再拼。"""

    source_job_id: uuid.UUID
    """一条已完成的编辑段，这段对话自己的或继承来的。"""
    user_name: UserName | None = None
    """规则同出片的 ``user_name``。"""

    conversation_id: uuid.UUID | None = None
    task_id: uuid.UUID | None = None
    metadata: Metadata | None = None


class ComposeSegment(CamelModel):
    """合成里的一段：从 ``url`` 那条视频取 ``[start, end)``，单位秒；``end`` 为空就取到那条的结尾。"""

    url: Annotated[str, Field(min_length=1, max_length=MAX_URL_CHARS)]
    start: float = Field(ge=0)
    end: float | None = None
    """开放的结尾由执行方按下载下来的素材时长补齐：编辑段产物与基底后段多长，受理时不知道。"""

    @field_validator("url")
    @classmethod
    def _downloadable(cls, url: str) -> str:
        if not is_http_url(url):
            raise ValueError("必须是 http:// 或 https:// 地址")
        return url

    @model_validator(mode="after")
    def _end_after_start(self) -> ComposeSegment:
        if self.end is not None and self.end <= self.start:
            raise ValueError("end 必须大于 start")
        return self


class VideoComposeRequest(CamelModel):
    """一次合成交给本地执行方的输入：按顺序取各段拼成一条，一律重编码对齐到原片。

    段由服务端按编辑段的基底与实际区间算出，调用方不直接给。``user_name`` 只作对账标签。"""

    kind: ClassVar[GenerationKind] = KIND_VIDEO
    operation: ClassVar[GenerationOperation] = OPERATION_COMPOSE

    segments: Annotated[list[ComposeSegment], Field(min_length=1)]
    user_name: UserName | None = None


GenerationRequest = VideoGenerationIn | ImageGenerationIn | VideoComposeRequest

_ADAPTERS: Final[Mapping[tuple[str, str], TypeAdapter[Any]]] = {
    (KIND_VIDEO, OPERATION_GENERATE): TypeAdapter(VideoGenerationIn),
    (KIND_IMAGE, OPERATION_GENERATE): TypeAdapter(ImageGenerationIn),
    (KIND_VIDEO, OPERATION_COMPOSE): TypeAdapter(VideoComposeRequest),
}
"""编辑段落库的仍是 ``VideoGenerationIn``：它与出片的区别在来源列上，不在请求形状上。"""

_WITHOUT_REQUEST: Final = frozenset(
    {(KIND_IMAGE, OPERATION_CUT), (KIND_IMAGE, OPERATION_UPLOAD), (KIND_VIDEO, OPERATION_UPLOAD)}
)
"""创建即完成、没有请求的那几种行：切图只有图片，上传图片与视频都有。"""


@overload
def request_to_payload(request: GenerationRequest) -> dict[str, Any]: ...
@overload
def request_to_payload(request: None) -> None: ...
def request_to_payload(request: GenerationRequest | None) -> dict[str, Any] | None:
    """序列化成持久化 JSON：字段名照请求自己的（视频 snake_case、图片 camelCase），归属字段单独存列。

    切图与上传没有请求，原样是 ``None``。"""

    if request is None:
        return None
    return request.model_dump(by_alias=True, exclude=set(ORIGIN_FIELDS))


def request_from_payload(
    kind: str, operation: str, payload: dict[str, Any] | None
) -> GenerationRequest | None:
    """按独立存列的 kind 与 operation 选择适配器并校验持久化请求，非法数据直接报错。

    切图与上传必须没有请求，读回 ``None``；其余几种必须有。"""

    if (kind, operation) in _WITHOUT_REQUEST:
        if payload is not None:
            raise ValidationFailed(f"{kind} / {operation} 不该带请求")
        return None
    adapter = _ADAPTERS.get((kind, operation))
    if adapter is None:
        raise ValidationFailed(f"未知的生成类型: {kind} / {operation}")
    if payload is None:
        raise ValidationFailed(f"{kind} / {operation} 的生成请求缺失")
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
    kind: GenerationKind
    operation: GenerationOperation
    status: GenerationStatus
    request: dict[str, Any] | None
    """发给执行方的输入，整份存取；切图与上传没有，为空。"""
    metadata: dict[str, Any] | None
    task_id: uuid.UUID | None
    shot_index: int | None = None
    """镜头组编号，只有视频有：出片由调用方给，编辑段与合成抄原作的；图片恒为空。"""
    root_job_id: uuid.UUID | None
    """原作：编辑段与合成指最初那条出片，出片与图片为空。按它筛（``rootJobId``）拿到整条编辑链。"""
    source_job_id: uuid.UUID | None = None
    """直接来源：编辑段指它的基底成片，合成指它的编辑段，帧图编辑指底图那一条，切图指它的宫格；
    别的为空。"""
    source_url: str | None = None
    """来源的地址：``sourceJobId`` 非空时是那条记录的 ``outputUrl``；为空时只有帧图编辑可能有，是
    库里找不到的外部底图地址；都没有就是空。它是投影，不是列的镜像，来源那条读不读得到都照给。"""
    range_start_ms: int | None = None
    range_end_ms: int | None = None
    """编辑段在基底上改的那一段，毫秒；参考片段切好之后是实际切点。只有编辑段有。"""
    output_url: str | None
    watermark_output_url: str | None
    """视频的水印版地址；图片与合成没有这一份，恒为空。"""
    error_message: str | None
    duration_ms: int | None
    """产物实际多长，毫秒；只有合成知道（本系统自己拼出来、量过），完成后才有，别的恒为空。"""
    clip_stage: ClipStage | None
    """在途的本地加工跑到哪一步：合成的取素材、拼接、上传，编辑段交上游之前的切片、上传。
    排队中、已有结论、交给上游之后都为空。"""
    created_at: datetime
    finished_at: datetime | None = None
    """到终态的时刻（数据库时钟）；同一镜头组的成片按它排版本。"""


def generation_out(job: GenerationJob, *, source_address: str | None) -> GenerationOut:
    """``source_address`` 是这一条来源的地址，由服务按来源批量查好给进来（见 ``GenerationOut.source_url``）。"""

    return GenerationOut(
        id=job.id,
        kind=job.kind,
        operation=job.operation,
        status=job.status,
        request=request_to_payload(job.request),
        metadata=job.metadata,
        task_id=job.task_id,
        shot_index=job.shot_index,
        root_job_id=job.root_job_id,
        source_job_id=job.source_job_id,
        source_url=source_address,
        range_start_ms=job.range_start_ms,
        range_end_ms=job.range_end_ms,
        output_url=job.output_url,
        watermark_output_url=job.watermark_output_url,
        error_message=job.error_message,
        duration_ms=job.duration_ms,
        clip_stage=_clip_stage(job),
        created_at=job.created_at,
        finished_at=job.finished_at,
    )


def _clip_stage(job: GenerationJob) -> ClipStage | None:
    """在途的本地加工跑到哪一步。

    只在 submitting 时认：收尾写终态时不带 provider_status，那一列会留着最后上报的阶段词，
    照它读会让一条已失败的记录看着还在上传。交给上游之后 provider_status 是上游的状态词，
    不在阶段词里，自然为空。"""

    if job.status != STATUS_SUBMITTING:
        return None
    return next((stage for stage in CLIP_STAGES if stage == job.provider_status), None)


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

_TASK_STATUS: Final[Mapping[GenerationStatus, VideoTaskStatus]] = {
    STATUS_PENDING: "queued",
    STATUS_SUBMITTING: "running",
    STATUS_SUBMITTED: "running",
    STATUS_COMPLETED: "succeeded",
    STATUS_FAILED: "failed",
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
    "CLIP_FETCHING",
    "CLIP_PROCESSING",
    "CLIP_UPLOADING",
    "IMAGE_MAX_REFERENCES",
    "KIND_IMAGE",
    "KIND_VIDEO",
    "MAX_METADATA_CHARS",
    "MAX_MODEL_CHARS",
    "MAX_PROMPT_CHARS",
    "MAX_REFERENCE_URLS",
    "MAX_USER_NAME_CHARS",
    "NOT_FORWARDED_FIELDS",
    "OPERATION_COMPOSE",
    "OPERATION_CUT",
    "OPERATION_GENERATE",
    "OPERATION_UPLOAD",
    "ORIGIN_FIELDS",
    "STATUS_COMPLETED",
    "STATUS_FAILED",
    "STATUS_PENDING",
    "STATUS_SUBMITTED",
    "STATUS_SUBMITTING",
    "ClipStage",
    "ComposeSegment",
    "GenerationEnvelope",
    "GenerationKind",
    "GenerationOperation",
    "GenerationOut",
    "GenerationRequest",
    "GenerationStatus",
    "GenerationsPageOut",
    "ImageGenerationIn",
    "ImageModelOut",
    "ImageModelsOut",
    "Metadata",
    "VideoComposeIn",
    "VideoComposeRequest",
    "VideoEditIn",
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
