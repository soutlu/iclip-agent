"""generation 装配单元：组合根只调用 ``build_generation_module``。

两家 provider 一起装。视频和图片是同一件产品能力的两半，声明「要生成」而只给一半
的接入，落到用户那里就是「点图片没反应，而且不报错」——所以两半的配置都必须在启动
期齐备，缺了直接不装这个模块。
"""

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
    """路由的类型写 ``Any``（同 identity）：装配单元不该把 web 框架拖进这一环。"""

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
    """装配 generation。两个 ``*_transport`` 只给测试注入 provider 替身用。

    ``queue_connector`` 由组合根造：procrastinate 只支持 psycopg，而「本仓用哪个数据
    库驱动」这种事该在组合根决定，不在业务模块里。测试传内存连接器。
    """

    providers: dict[GenerationKind, GenerationProvider] = {
        KIND_VIDEO: MultiflowVideoProvider(video, transport=video_transport),
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
