"""媒体生成模块装配。图片按配置里声明的那几家逐个装，视频固定一家。"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

import httpx
import procrastinate

from iclip.domains.generation.api import create_generations_router
from iclip.domains.generation.nano_banana import (
    PROVIDER_NAME as NANO_BANANA_PRO,
)
from iclip.domains.generation.nano_banana import (
    SPEC as NANO_BANANA_PRO_SPEC,
)
from iclip.domains.generation.nano_banana import (
    NanoBananaImageProvider,
    NanoBananaSettings,
)
from iclip.domains.generation.provider import GenerationProvider, ImageModelSpec
from iclip.domains.generation.queue import (
    GenerationQueue,
    GenerationQueueSettings,
    ProviderLane,
)
from iclip.domains.generation.repository import GenerationRepository
from iclip.domains.generation.seedream import (
    PROVIDER_NAME as SEEDREAM_V5_PRO,
)
from iclip.domains.generation.seedream import (
    SPEC as SEEDREAM_V5_PRO_SPEC,
)
from iclip.domains.generation.seedream import (
    SeedreamImageProvider,
    SeedreamSettings,
)
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

    image_models: frozenset[str]
    """装配好的图片模型名，供组合根校验别处钉死的那家在不在里面。"""


def build_generation_module(
    repo: GenerationRepository,
    *,
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

    对象存储只给图片用：图片网关给的是会过期的签名地址，要转存；视频上游给的是它自己
    发布好的稳定地址，直接存。"""

    if not image_models:
        raise RuntimeError("媒体生成开着却一家图片模型都没声明")
    declared = [model.name for model in image_models]
    if image_default_model not in declared:
        raise RuntimeError(
            f"默认图片模型 {image_default_model} 不在声明的那几家里（{'、'.join(declared)}）"
        )
    settings = queue_settings or GenerationQueueSettings()
    video_provider = HttpVideoProvider(video, transport=video_transport)
    image_providers = [
        _image_provider(model, env=image_env, object_store=object_store, transport=image_transport)
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
        video_default_model=video_default_model,
        video_allowed_models=video_allowed_models,
        image_models={name: IMAGE_MODEL_SPECS[name] for name in declared},
        image_default_model=image_default_model,
    )
    return GenerationModule(
        routers=(create_generations_router(service),),
        service=service,
        queue=queue,
        image_models=frozenset(declared),
    )


IMAGE_MODEL_SPECS: Final[Mapping[str, ImageModelSpec]] = {
    NANO_BANANA_PRO: NANO_BANANA_PRO_SPEC,
    SEEDREAM_V5_PRO: SEEDREAM_V5_PRO_SPEC,
}
"""有适配器的那几家图片模型及其能力声明。加一家＝这里一行，加一支 _image_provider 分支。"""


def _image_provider(
    model: ImageModelConfig,
    *,
    env: str,
    object_store: PublicObjectStore,
    transport: httpx.AsyncBaseTransport | None,
) -> GenerationProvider:
    """按声明的名字建这家的适配器；名字没有对应实现就在装配期报错。"""

    if model.name == NANO_BANANA_PRO:
        return NanoBananaImageProvider(
            NanoBananaSettings(api_base=model.api_base, env=env),
            object_store=object_store,
            transport=transport,
        )
    if model.name == SEEDREAM_V5_PRO:
        return SeedreamImageProvider(
            SeedreamSettings(api_base=model.api_base, env=env),
            object_store=object_store,
            transport=transport,
        )
    raise RuntimeError(
        f"没有 {model.name} 这家图片模型的适配器（现有：{'、'.join(IMAGE_MODEL_SPECS)}）"
    )


__all__ = [
    "IMAGE_MODEL_SPECS",
    "GenerationModule",
    "ImageModelConfig",
    "build_generation_module",
]
