"""能力名称到运行实例的装配表。agents.yaml 仅声明名称，组合根注入连接池与领域服务等运行对象。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from typing import Any, ClassVar, Protocol, runtime_checkable

import httpx
from pydantic import ValidationError

from iclip.capabilities.shot_video.capability import GenerationPolicy, shot_video_capability
from iclip.capabilities.shot_video.ports import (
    ImageJob,
    ImageRequest,
    InvalidImageRequest,
    ObjectWriteFailed,
)
from iclip.capabilities.video.capability import Video
from iclip.capabilities.video_understanding import ArkVideoUnderstanding
from iclip.capabilities.workspace.capability import workspace_capability
from iclip.capabilities.workspace.ports import ImageInfo, MediaProbeFailed
from iclip.capabilities.workspace.scope import workspace_namespace
from iclip.common.errors import ValidationFailed
from iclip.config import ResolvedShotVideo, ResolvedVideo
from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.schemas import ImageGenerationIn
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.public import Principal
from iclip.harness.agents import AgentCapabilities, delegate_display_table
from iclip.harness.skills import skill_display_table
from iclip.platform.file_store.store import FileSpace, FileStore
from iclip.platform.material_ledger.store import MaterialLedger
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.oss import ObjectStoreUnavailable, PublicObjectStore
from iclip.platform.transcript.display import ToolDisplayRegistry, ToolDisplaySource

CapabilityTable = Mapping[str, AgentCapabilities]
"""能力名称对应一组实例；同一声明可挂载多项能力，运行状态由 for_run 克隆隔离。"""


@runtime_checkable
class RequiresCapabilities(Protocol):
    """要求同一 agent 一起挂载其它能力名的能力；没有这个属性就是不要求。"""

    REQUIRES: ClassVar[tuple[str, ...]]


class GenerationsAdapter:
    """将能力请求转换为生成域的统一请求模型，并将任务记录收窄为能力协议字段。"""

    def __init__(self, service: GenerationService) -> None:
        self._service = service

    async def submit(self, principal: Principal, request: ImageRequest) -> ImageJob:
        try:
            # 模型输入为自由字符串，由生成域请求模型统一校验枚举。
            payload = ImageGenerationIn.model_validate(
                {
                    "prompt": request.prompt,
                    "user_name": request.user_name,
                    "model": request.model,
                    "channel": request.channel,
                    "aspect_ratio": request.aspect_ratio,
                    "resolution": request.resolution,
                    "reference_image_urls": list(request.reference_image_urls),
                    "conversation_id": request.conversation_id,
                }
            )
            return _job_view(await self._service.submit_image(principal, payload))
        except ValidationError as exc:
            raise InvalidImageRequest(_first_problem(exc)) from exc
        except ValidationFailed as exc:
            # 受理层按所选模型的能力拒绝，收成能力协议错误，工具才能让模型改参数。
            raise InvalidImageRequest(str(exc)) from exc

    async def get(self, principal: Principal, job_id: uuid.UUID) -> ImageJob:
        return _job_view(await self._service.get(principal, job_id))


_IMAGE_MEDIA_TYPES: Mapping[str, str] = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
    "gif": "image/gif",
}


class OssMediaProbe:
    """通过 OSS image/info 查询尺寸、大小与格式，无需下载像素。

    对外错误使用固定文案，避免 HTTP 异常回显带参数的地址。"""

    def __init__(self, client: httpx.AsyncClient) -> None:
        self._client = client

    async def image_info(self, url: str) -> ImageInfo:
        try:
            response = await self._client.get(f"{url}?x-oss-process=image/info")
        except httpx.HTTPError as exc:
            raise MediaProbeFailed("地址访问不到") from exc
        if response.status_code >= 400:
            raise MediaProbeFailed(f"对方返回 {response.status_code}")
        try:
            info = response.json()
            image_format = str(info["Format"]["value"]).lower()
            return ImageInfo(
                media_type=_IMAGE_MEDIA_TYPES.get(image_format, f"image/{image_format}"),
                size_bytes=int(info["FileSize"]["value"]),
                width=int(info["ImageWidth"]["value"]),
                height=int(info["ImageHeight"]["value"]),
            )
        except (ValueError, TypeError, KeyError, IndexError) as exc:
            raise MediaProbeFailed("对方给的不是图片信息") from exc


class ObjectWriterAdapter:
    """将对象存储异常转换为能力协议错误，使工具可报告失败而非终止整个运行。"""

    def __init__(self, store: PublicObjectStore) -> None:
        self._store = store

    async def put_public_object(self, *, object_key: str, content: bytes, content_type: str) -> str:
        try:
            return await self._store.put_public_object(
                object_key=object_key, content=content, content_type=content_type
            )
        except ObjectStoreUnavailable as exc:
            raise ObjectWriteFailed(str(exc)) from exc


def _job_view(job: GenerationJob) -> ImageJob:
    """生成任务到能力结果的投影，渠道取实际请求快照。"""

    request = job.request
    if not isinstance(request, ImageGenerationIn):
        # 出图适配器只提交图片请求；拿回视频请求说明装配串了，不替它编一个渠道。
        raise TypeError(f"图像任务 {job.id} 的请求是 {job.kind}")
    if request.channel is None:
        # 出图钉死的那家有渠道轴（装配期校验过），为空同样说明装配串了。
        raise TypeError(f"图像任务 {job.id} 没有渠道")
    return ImageJob(
        job_id=job.id,
        status=job.status,
        channel=request.channel,
        output_url=job.output_url,
        error_code=job.error_code,
        error_message=job.error_message,
    )


def _first_problem(exc: ValidationError) -> str:
    """提取首个字段校验错误供调用方修正。"""

    first = exc.errors()[0]
    where = ".".join(str(part) for part in first["loc"]) or "参数"
    return f"{where}: {first['msg']}"


def build_capability_table(
    *,
    workspace_store: FileStore,
    material_ledger: MaterialLedger,
    http_client: httpx.AsyncClient,
    generation_service: GenerationService | None = None,
    object_store: PublicObjectStore | None = None,
    video: ResolvedVideo | None = None,
    shot_video: ResolvedShotVideo | None = None,
    image_models: frozenset[str] = frozenset(),
) -> CapabilityTable:
    """按组合根递进来的运行值登记能力名，没给的不登记。

    ``shot_video`` 由组合根按 ``ResolvedSettings.shot_tools_enabled`` 决定是否传入；传了却缺
    媒体生成或对象存储是装配错误，直接报。
    """

    # 文件生产与读取共用 FileSpace，避免命名空间不一致。
    space = FileSpace(store=workspace_store, namespace=workspace_namespace)
    table: dict[str, AgentCapabilities] = {
        "workspace": (
            workspace_capability(
                space=space, probe=OssMediaProbe(http_client), ledger=material_ledger
            ),
        ),
    }
    if video is not None:
        table["video"] = (
            Video[Any](
                space=space,
                ledger=material_ledger,
                understanding=ArkVideoUnderstanding(
                    http_client,
                    url=video.understanding_url,
                    api_key=video.understanding_api_key,
                    model=video.understanding_model,
                    thinking=video.understanding_thinking,
                    fps=video.understanding_fps,
                ),
            ),
        )
    if shot_video is not None:
        if generation_service is None or object_store is None:
            raise RuntimeError(
                "装配 shot_video 要有媒体生成服务与对象存储；组合根应按 shot_tools_enabled 决定是否传入"
            )
        table["shot_video"] = (
            shot_video_capability(
                space=space,
                ledger=material_ledger,
                generations=GenerationsAdapter(generation_service),
                objects=ObjectWriterAdapter(object_store),
                paths=MEDIA_PATHS,
                client=http_client,
                image_models=image_models,
                policy=GenerationPolicy(
                    poll_interval_seconds=shot_video.poll_interval_seconds,
                    dev_attempts=shot_video.dev_attempts,
                    pro_attempts=shot_video.pro_attempts,
                    backoff_seconds=shot_video.backoff_seconds,
                    backoff_factor=shot_video.backoff_factor,
                    total_timeout_seconds=shot_video.job_timeout_seconds,
                ),
            ),
        )
    return table


def build_display_registry(table: CapabilityTable) -> ToolDisplayRegistry:
    """合并能力、技能与委派工具的显示表，重复工具名在装配期报错。实时与历史共用结果实例。"""

    return ToolDisplayRegistry.merged(
        *(
            capability.display_table()
            for mounted in table.values()
            for capability in mounted
            if isinstance(capability, ToolDisplaySource)
        ),
        skill_display_table(),
        delegate_display_table(),
    )


def resolve_capabilities(
    names: Sequence[str], *, table: CapabilityTable, declared_by: str
) -> AgentCapabilities:
    """按名字取能力；名字没登记、或少挂了它要求同挂的名字，即报错（装配期 fail fast）。"""

    resolved: AgentCapabilities = ()
    for name in names:
        found = table.get(name)
        if found is None:
            known = ", ".join(table) or "（还没有登记任何 capability）"
            raise RuntimeError(
                f"{declared_by} 引用了未登记的 capability {name!r}；已登记的有: {known}"
            )
        required = (
            requirement
            for capability in found
            if isinstance(capability, RequiresCapabilities)
            for requirement in capability.REQUIRES
        )
        missing = [requirement for requirement in required if requirement not in names]
        if missing:
            raise RuntimeError(
                f"{declared_by} 挂了 capability {name!r} 却没挂 {', '.join(map(repr, missing))}——"
                f"{name} 写的文件要靠它们让模型看见；在 agents.yaml 里一起挂上。"
            )
        resolved = (*resolved, *found)
    return resolved


__all__ = [
    "CapabilityTable",
    "GenerationsAdapter",
    "ObjectWriterAdapter",
    "OssMediaProbe",
    "RequiresCapabilities",
    "build_capability_table",
    "build_display_registry",
    "resolve_capabilities",
]
