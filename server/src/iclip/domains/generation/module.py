"""媒体生成模块装配。图片按配置里声明的那几家逐个装，视频固定一家，本地裁剪拼接一家。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

import httpx
import procrastinate

from iclip.domains.generation.api import create_generations_router
from iclip.domains.generation.clip import FfmpegClipProvider, ReportClipStage
from iclip.domains.generation.image_upstream import (
    GatewayImageModel,
    GatewayImageProvider,
    GatewayImageSettings,
)
from iclip.domains.generation.models import STATUS_SUBMITTING
from iclip.domains.generation.nano_banana import NANO_BANANA_PRO
from iclip.domains.generation.provider import GenerationProvider, ImageModelSpec
from iclip.domains.generation.queue import (
    GenerationQueue,
    GenerationQueueSettings,
    ProviderLane,
)
from iclip.domains.generation.repository import GenerationRepository
from iclip.domains.generation.schemas import ClipStage
from iclip.domains.generation.seedream import SEEDREAM_V5_PRO
from iclip.domains.generation.service import ClearCompletion, GenerationService
from iclip.domains.generation.video import (
    HttpVideoProvider,
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

    对象存储给图片与本地视频加工用：图片网关给的是会过期的签名地址，要转存；裁剪拼接的
    产物本来就是我们自己造的。视频上游给的是它自己发布好的稳定地址，不转存。"""

    if not image_models:
        raise RuntimeError("媒体生成开着却一家图片模型都没声明")
    declared = [model.name for model in image_models]
    if image_default_model not in declared:
        raise RuntimeError(
            f"默认图片模型 {image_default_model} 不在声明的那几家里（{'、'.join(declared)}）"
        )
    settings = queue_settings or GenerationQueueSettings()
    video_provider = HttpVideoProvider(video, transport=video_transport)
    clip_provider = FfmpegClipProvider(
        object_store=object_store, report_stage=_clip_stage_reporter(repo)
    )
    image_providers = [
        _image_provider(model, env=image_env, object_store=object_store, transport=image_transport)
        for model in image_models
    ]
    queue = GenerationQueue(
        repo,
        lanes=(
            ProviderLane(video_provider, settings.video_submit_concurrency),
            # 裁剪拼接是 CPU 活，和只等网络的提交分开排，免得它把别人的槽位占满。
            ProviderLane(clip_provider, settings.clip_concurrency),
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
        clip_provider_name=clip_provider.name,
        video_default_model=video_default_model,
        video_allowed_models=video_allowed_models,
        image_models={name: IMAGE_MODEL_SPECS[name] for name in declared},
        image_default_model=image_default_model,
        clear_completion=clear_completion,
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


def _clip_stage_reporter(repo: GenerationRepository) -> ReportClipStage:
    """把 provider 报的阶段落到 provider_status 上，provider 自己不碰数据库。

    只在提交中更新，返回这条是不是还在提交中。不带快照：快照整份覆盖写，捎带上会把完成时
    那次写打掉。"""

    async def report(job_id: uuid.UUID, stage: ClipStage) -> bool:
        updated = await repo.record_progress(
            job_id, provider_status=stage, only_if_status=STATUS_SUBMITTING
        )
        return updated is not None

    return report


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
