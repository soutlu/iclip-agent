"""命名模型的装配：一条配置声明 → 一个官方 ``Model`` 实例。"""

from __future__ import annotations

import inspect
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, cast

from openai import AsyncOpenAI
from pydantic_ai.models import Model, infer_model
from pydantic_ai.providers import Provider, infer_provider_class

ModelApi = Literal["chat", "responses"]

BuiltModels = Mapping[str, Model]
"""名字 → 模型实例。"""


@dataclass(frozen=True, slots=True)
class ModelSpec:
    """一个命名模型的装配输入。``name`` 是 agent 引用的名字。"""

    name: str
    provider: str
    model: str
    api: ModelApi
    api_key: str
    base_url: str | None


def _build_provider(spec: ModelSpec) -> Provider[Any]:
    """按配置造 provider；provider 名不认识即报错。"""

    provider_class = cast("Any", infer_provider_class(spec.provider))
    if spec.base_url is None:
        return cast("Provider[Any]", provider_class(api_key=spec.api_key))

    # 各家构造签名不统一：收 base_url 的直接传，只收 api_key 的走 openai_client。
    parameters = inspect.signature(provider_class.__init__).parameters
    if "base_url" in parameters:
        return cast("Provider[Any]", provider_class(api_key=spec.api_key, base_url=spec.base_url))
    if "openai_client" in parameters:
        client = AsyncOpenAI(base_url=spec.base_url, api_key=spec.api_key)
        return cast("Provider[Any]", provider_class(openai_client=client))
    raise RuntimeError(
        f"模型 {spec.name}：provider {spec.provider} 不支持自定义 base_url，请去掉该字段"
    )


def build_model(spec: ModelSpec) -> Model:
    """造一个 ``Model``；provider 名非法或组合不成立即报错。"""

    provider = _build_provider(spec)
    if spec.api == "chat":
        # 模型类由官方按 provider 名决定：Ollama、OpenRouter 等各有专属类。
        return infer_model(f"{spec.provider}:{spec.model}", provider_factory=lambda _: provider)

    if not isinstance(provider.client, AsyncOpenAI):
        raise RuntimeError(
            f"模型 {spec.name}：api: responses 只适用于 OpenAI 兼容的 provider，"
            f"{spec.provider} 不是"
        )
    from pydantic_ai.models.openai import OpenAIResponsesModel

    return OpenAIResponsesModel(spec.model, provider=provider)


def build_models(specs: Sequence[ModelSpec]) -> BuiltModels:
    """按名字造出全部模型；同名只造一个实例。"""

    return {spec.name: build_model(spec) for spec in specs}


__all__ = ["BuiltModels", "ModelApi", "ModelSpec", "build_model", "build_models"]
