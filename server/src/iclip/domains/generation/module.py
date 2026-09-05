"""媒体生成模块装配。图片与视频 Provider 必须同时配置，启动时校验依赖完整性。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx
import procrastinate

from iclip.domains.generation.api import create_generations_router
from iclip.domains.generation.models import GenerationKind
from iclip.domains.generation.multiflow import (
    MultiflowSettings,
    MultiflowVideoProvider,
)
from iclip.domains.generation.nano_banana import (
    NanoBananaImageProvider,
    NanoBananaSettings,
)
from iclip.domains.generation.provider import GenerationProvider
from iclip.domains.generation.queue import GenerationQueue, GenerationQueueSettings
from iclip.domains.generation.repository import GenerationRepository
from iclip.domains.generation.schemas import KIND_IMAGE, KIND_VIDEO
from iclip.domains.generation.service import GenerationService
from iclip.platform.object_store.oss import PublicObjectStore


@dataclass(frozen=True)
class GenerationModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    service: GenerationService
    queue: GenerationQueue


def build_generation_module(
    repo: GenerationRepository,
    *,
    video: MultiflowSettings,
    image: NanoBananaSettings,
    object_store: PublicObjectStore,
    queue_connector: procrastinate.BaseConnector,
    queue_settings: GenerationQueueSettings | None = None,
    video_transport: httpx.AsyncBaseTransport | None = None,
    image_transport: httpx.AsyncBaseTransport | None = None,
) -> GenerationModule:
    """装配 Provider 与队列；transport 支持测试替身，queue_connector 由组合根选择数据库驱动。"""

    providers: dict[GenerationKind, GenerationProvider] = {
        KIND_VIDEO: MultiflowVideoProvider(
            video, object_store=object_store, transport=video_transport
        ),
        KIND_IMAGE: NanoBananaImageProvider(
            image, object_store=object_store, transport=image_transport
        ),
    }
    queue = GenerationQueue(
        repo,
        providers=providers,
        connector=queue_connector,
        settings=queue_settings,
    )
    service = GenerationService(
        repo,
        queue,
        video_provider_name=providers[KIND_VIDEO].name,
        image_provider_name=providers[KIND_IMAGE].name,
    )
    return GenerationModule(
        routers=(create_generations_router(service),),
        service=service,
        queue=queue,
    )


__all__ = ["GenerationModule", "build_generation_module"]
