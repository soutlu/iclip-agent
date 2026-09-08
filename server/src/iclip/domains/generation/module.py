"""媒体生成模块装配。图片按配置里声明的那几家逐个装，视频固定一家。"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import httpx
import procrastinate

from iclip.domains.generation.api import create_generations_router
from iclip.domains.generation.nano_banana import (
    PROVIDER_NAME as NANO_BANANA_PRO,
)
from iclip.domains.generation.nano_banana import (
    NanoBananaImageProvider,
    NanoBananaSettings,
)
from iclip.domains.generation.provider import GenerationProvider
from iclip.domains.generation.queue import (
    GenerationQueue,
    GenerationQueueSettings,
    ProviderLane,
)
from iclip.domains.generation.repository import GenerationRepository
from iclip.domains.generation.service import GenerationService
from iclip.domains.generation.video import (
    HttpVideoProvider,
    VideoProviderSettings,
)
from iclip.platform.object_store.oss import PublicObjectStore


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


def build_generation_module(
    repo: GenerationRepository,
    *,
    video: VideoProviderSettings,
    video_allowed_models: tuple[str, ...],
    image_models: Sequence[ImageModelConfig],
    image_user_name: str,
    object_store: PublicObjectStore,
    queue_connector: procrastinate.BaseConnector,
    queue_settings: GenerationQueueSettings | None = None,
    video_transport: httpx.AsyncBaseTransport | None = None,
    image_transport: httpx.AsyncBaseTransport | None = None,
) -> GenerationModule:
    """装配 Provider 与队列；transport 支持测试替身，queue_connector 由组合根选择数据库驱动。"""

    if not image_models:
        raise RuntimeError("媒体生成开着却一家图片模型都没声明")
    settings = queue_settings or GenerationQueueSettings()
    video_provider = HttpVideoProvider(video, object_store=object_store, transport=video_transport)
    image_providers = [
        _image_provider(
            model,
            user_name=image_user_name,
            object_store=object_store,
            transport=image_transport,
        )
        for model in image_models
    ]
    queue = GenerationQueue(
        repo,
        lanes=(
            ProviderLane(video_provider, settings.video_submit_concurrency),
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
        # 受理层现在把每次图片生成都记到第一家名下；按请求选哪一家属于对外合同那一层。
        image_provider_name=image_providers[0].name,
        video_model=video.model,
        video_allowed_models=video_allowed_models,
    )
    return GenerationModule(
        routers=(create_generations_router(service),),
        service=service,
        queue=queue,
    )


def _image_provider(
    model: ImageModelConfig,
    *,
    user_name: str,
    object_store: PublicObjectStore,
    transport: httpx.AsyncBaseTransport | None,
) -> GenerationProvider:
    """按声明的名字建这家的适配器；名字没有对应实现就在装配期报错。"""

    if model.name != NANO_BANANA_PRO:
        raise RuntimeError(f"没有 {model.name} 这家图片模型的适配器（现有：{NANO_BANANA_PRO}）")
    return NanoBananaImageProvider(
        NanoBananaSettings(api_base=model.api_base, user_name=user_name),
        object_store=object_store,
        transport=transport,
    )


__all__ = ["GenerationModule", "ImageModelConfig", "build_generation_module"]
