"""能力名称到运行实例的装配表。agents.yaml 仅声明名称，组合根注入连接池与领域服务等运行对象。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence

import httpx
from pydantic import ValidationError

from iclip.capabilities.shot_video.capability import GenerationPolicy, shot_video_capability
from iclip.capabilities.shot_video.parser import ArkVideoUnderstanding
from iclip.capabilities.shot_video.ports import (
    ImageJob,
    ImageRequest,
    InvalidImageRequest,
    ObjectWriteFailed,
)
from iclip.capabilities.workspace.capability import workspace_capability
from iclip.capabilities.workspace.ports import ImageInfo, MediaProbeFailed
from iclip.capabilities.workspace.scope import workspace_namespace
from iclip.config import ResolvedShotVideo
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

REQUIRES: Mapping[str, tuple[str, ...]] = {"shot_video": ("workspace",)}
"""能力挂载依赖；shot_video 的文档与台账需要 workspace 工具访问，装配时统一校验。"""


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
                    "channel": request.channel,
                    "aspect_ratio": request.aspect_ratio,
                    "resolution": request.resolution,
                    "reference_image_urls": list(request.reference_image_urls),
                    "conversation_id": request.conversation_id,
                }
            )
        except ValidationError as exc:
            raise InvalidImageRequest(_first_problem(exc)) from exc
        return _job_view(await self._service.submit(principal, payload))

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
    return ImageJob(
        job_id=job.id,
        status=job.status,
        channel=request.channel if isinstance(request, ImageGenerationIn) else "dev",
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
    shot_video: ResolvedShotVideo | None = None,
) -> CapabilityTable:
    """装配已启用的能力。shot_video 依赖完整的生成服务与对象存储；缺失时不登记该名称。"""

    # 文件生产与读取共用 FileSpace，避免命名空间不一致。
    space = FileSpace(store=workspace_store, namespace=workspace_namespace)
    table: dict[str, AgentCapabilities] = {
        "workspace": (
            workspace_capability(
                space=space, probe=OssMediaProbe(http_client), ledger=material_ledger
            ),
        ),
    }
    if shot_video is not None and generation_service is not None and object_store is not None:
        table["shot_video"] = (
            shot_video_capability(
                space=space,
                ledger=material_ledger,
                generations=GenerationsAdapter(generation_service),
                objects=ObjectWriterAdapter(object_store),
                paths=MEDIA_PATHS,
                understanding=ArkVideoUnderstanding(
                    http_client,
                    url=shot_video.understanding_url,
                    api_key=shot_video.understanding_api_key,
                    model=shot_video.understanding_model,
                    thinking=shot_video.understanding_thinking,
                    fps=shot_video.understanding_fps,
                ),
                client=http_client,
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
        missing = [required for required in REQUIRES.get(name, ()) if required not in names]
        if missing:
            raise RuntimeError(
                f"{declared_by} 挂了 capability {name!r} 却没挂 {', '.join(map(repr, missing))}——"
                f"{name} 写的文件要靠它们让模型看见；在 agents.yaml 里一起挂上。"
            )
        resolved = (*resolved, *found)
    return resolved


__all__ = [
    "REQUIRES",
    "CapabilityTable",
    "GenerationsAdapter",
    "ObjectWriterAdapter",
    "OssMediaProbe",
    "build_capability_table",
    "build_display_registry",
    "resolve_capabilities",
]
