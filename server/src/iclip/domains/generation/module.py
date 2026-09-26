"""媒体生成模块装配。图片按配置里声明的那几家逐个装，视频固定一家（编辑段交上游前由它先切参考
片段），本地合成一家。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

import httpx
import procrastinate

from iclip.domains.generation.api import create_generations_router
from iclip.domains.generation.image_upstream import (
    GatewayImageModel,
    GatewayImageProvider,
    GatewayImageSettings,
)
from iclip.domains.generation.models import STATUS_SUBMITTING, GenerationJob
from iclip.domains.generation.nano_banana import NANO_BANANA_PRO
from iclip.domains.generation.processing import (
    FfmpegComposeProvider,
    ReferenceCutter,
    ReportStage,
)
from iclip.domains.generation.provider import GenerationProvider, ImageModelSpec, ProviderError
from iclip.domains.generation.queue import (
    GenerationQueue,
    GenerationQueueSettings,
    ProviderLane,
)
from iclip.domains.generation.repository import GenerationRepository
from iclip.domains.generation.schemas import ClipStage
from iclip.domains.generation.seedream import SEEDREAM_V5_PRO
from iclip.domains.generation.service import (
    ClearCompletion,
    ConversationLineage,
    GenerationService,
)
from iclip.domains.generation.video import (
    HttpVideoProvider,
    PrepareReference,
    VideoProviderSettings,
)
from iclip.domains.identity.public import ActAs
from iclip.platform.object_store.store import PublicObjectStore


@dataclass(frozen=True, slots=True)
class ImageModelConfig:
    """一家图片模型的装配输入。``name`` 就是落库的 provider 名，也是它那条队列的名字。"""

    name: str
    api_base: str
    """这家在网关上的地址，两条任务路由由适配器拼在它后面。"""

    concurrency: int
    """这家同时最多挂几个提交。"""


@dataclass(frozen=True)
class GenerationModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    service: GenerationService
    queue: GenerationQueue

    image_models: frozenset[str]
    """装配好的图片模型名，供组合根校验别处钉死的那家在不在里面。"""


def build_generation_module(
    repo: GenerationRepository,
    *,
    act_as: ActAs,
    clear_completion: ClearCompletion,
    lineage: ConversationLineage,
    video: VideoProviderSettings,
    video_default_model: str,
    video_allowed_models: tuple[str, ...],
    image_models: Sequence[ImageModelConfig],
    image_default_model: str,
    image_env: str,
    object_store: PublicObjectStore,
    queue_connector: procrastinate.BaseConnector,
    queue_settings: GenerationQueueSettings | None = None,
    video_transport: httpx.AsyncBaseTransport | None = None,
    image_transport: httpx.AsyncBaseTransport | None = None,
) -> GenerationModule:
    """装配 Provider 与队列；transport 支持测试替身，queue_connector 由组合根选择数据库驱动。

    对象存储给图片与本地视频加工用：图片网关给的是会过期的签名地址，要转存；参考片段与合成的
    产物本来就是我们自己造的。视频上游给的是它自己发布好的稳定地址，不转存。"""

    if not image_models:
        raise RuntimeError("媒体生成开着却一家图片模型都没声明")
    declared = [model.name for model in image_models]
    if image_default_model not in declared:
        raise RuntimeError(
            f"默认图片模型 {image_default_model} 不在声明的那几家里（{'、'.join(declared)}）"
        )
    settings = queue_settings or GenerationQueueSettings()
    report_stage = _clip_stage_reporter(repo)
    cutter = ReferenceCutter(object_store=object_store, report_stage=report_stage)
    video_provider = HttpVideoProvider(
        video, prepare_reference=_reference_preparer(repo, cutter), transport=video_transport
    )
    compose_provider = FfmpegComposeProvider(object_store=object_store, report_stage=report_stage)
    image_providers = [
        _image_provider(model, env=image_env, object_store=object_store, transport=image_transport)
        for model in image_models
    ]
    queue = GenerationQueue(
        repo,
        lanes=(
            # 编辑段切参考片段不重编码、只花 IO，与出片共用视频这条 lane。
            ProviderLane(video_provider, settings.video_submit_concurrency),
            # 合成要整条重编码，是 CPU 活，和只等网络的提交分开排，免得它把别人的槽位占满。
            ProviderLane(compose_provider, settings.compose_concurrency),
            *(
                ProviderLane(provider, model.concurrency)
                for provider, model in zip(image_providers, image_models, strict=True)
            ),
        ),
        connector=queue_connector,
        settings=queue_settings,
    )
    service = GenerationService(
        repo,
        queue,
        video_provider_name=video_provider.name,
        compose_provider_name=compose_provider.name,
        video_default_model=video_default_model,
        video_allowed_models=video_allowed_models,
        image_models={name: IMAGE_MODEL_SPECS[name] for name in declared},
        image_default_model=image_default_model,
        clear_completion=clear_completion,
        lineage=lineage,
    )
    return GenerationModule(
        routers=(create_generations_router(service, act_as=act_as),),
        service=service,
        queue=queue,
        image_models=frozenset(declared),
    )


_IMAGE_MODELS: Final[Mapping[str, GatewayImageModel]] = {
    model.name: model for model in (NANO_BANANA_PRO, SEEDREAM_V5_PRO)
}
"""有适配器的那几家图片模型，适配器与能力声明都从这张表出。加一家＝这里加一项。"""

IMAGE_MODEL_SPECS: Final[Mapping[str, ImageModelSpec]] = {
    name: model.spec for name, model in _IMAGE_MODELS.items()
}
"""各家图片模型的能力声明。"""


def _clip_stage_reporter(repo: GenerationRepository) -> ReportStage:
    """把 provider 报的阶段落到 provider_status 上，provider 自己不碰数据库。

    只在提交中更新，返回这条是不是还在提交中。"""

    async def report(job_id: uuid.UUID, stage: ClipStage) -> bool:
        updated = await repo.record_progress(
            job_id, provider_status=stage, only_if_status=STATUS_SUBMITTING
        )
        return updated is not None

    return report


def _reference_preparer(repo: GenerationRepository, cutter: ReferenceCutter) -> PrepareReference:
    """编辑段交上游前的一步：从基底上切参考片段，把实际切点记回这一行，交回片段地址。

    记切点带状态守卫：这一行已不在提交中（别的执行已给它下了结论），就不能再去调付费上游。"""

    async def prepare(job: GenerationJob) -> str:
        source_id, start_ms, end_ms = job.source_job_id, job.range_start_ms, job.range_end_ms
        if source_id is None or start_ms is None or end_ms is None:
            # 组合约束保证编辑段三者齐全；走到这里是把别的行当成编辑段交了过来。
            raise RuntimeError(f"生成记录 {job.id} 不是编辑段，不该切参考片段")
        base = await repo.get(source_id, owner=None)
        if base.output_url is None:
            raise ProviderError(
                f"编辑段的基底 {base.id} 没有产物地址",
                code="MEDIA_SOURCE_UNREACHABLE",
                retryable=False,
            )
        cut = await cutter.cut(
            job_id=job.id, source_url=base.output_url, start_ms=start_ms, end_ms=end_ms
        )
        recorded = await repo.record_reference_cut(
            job.id,
            range_start_ms=cut.start_ms,
            range_end_ms=cut.end_ms,
            only_if_status=STATUS_SUBMITTING,
        )
        if recorded is None:
            raise ProviderError(
                "参考片段切好时这次编辑已有结论，不再交给上游",
                code="EDIT_ALREADY_SETTLED",
                retryable=False,
            )
        return cut.url

    return prepare


def _image_provider(
    config: ImageModelConfig,
    *,
    env: str,
    object_store: PublicObjectStore,
    transport: httpx.AsyncBaseTransport | None,
) -> GenerationProvider:
    """按声明的名字查表建这家的适配器；名字没有对应实现就在装配期报错。"""

    model = _IMAGE_MODELS.get(config.name)
    if model is None:
        raise RuntimeError(
            f"没有 {config.name} 这家图片模型的适配器（现有：{'、'.join(_IMAGE_MODELS)}）"
        )
    return GatewayImageProvider(
        model,
        GatewayImageSettings(api_base=config.api_base, env=env),
        object_store=object_store,
        transport=transport,
    )


__all__ = [
    "IMAGE_MODEL_SPECS",
    "GenerationModule",
    "ImageModelConfig",
    "build_generation_module",
]
