"""命名模型的装配：一条配置声明 → 一个官方 ``Model`` 实例。"""

from __future__ import annotations

import inspect
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, cast

from openai import AsyncOpenAI, AsyncStream
from openai.types import responses
from pydantic_ai.models import Model, ModelRequestParameters, infer_model
from pydantic_ai.models.openai import (
    OpenAIChatModelSettings,
    OpenAIModelName,
    OpenAIResponsesModel,
    OpenAIResponsesModelSettings,
    OpenAIResponsesStreamedResponse,
)
from pydantic_ai.providers import Provider, infer_provider_class

ModelApi = Literal["chat", "responses"]

ThinkingEffort = Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"]
"""思考强度档位，即 OpenAI 方言的 ``reasoning.effort``。"""

BuiltModels = Mapping[str, Model]
"""名字 → 模型实例。"""


@dataclass(frozen=True, slots=True)
class ModelSpec:
    """一个命名模型的装配输入。``name`` 是 agent 引用的名字；``thinking`` 不写即厂商默认档。"""

    name: str
    provider: str
    model: str
    api: ModelApi
    api_key: str
    base_url: str | None
    thinking: ThinkingEffort | None = None


class _RawReasoningAsSummary:
    """每条原始思维链块后面补一条同 id 的 summary 块，其余事件原样透传。"""

    def __init__(self, source: AsyncStream[responses.ResponseStreamEvent]) -> None:
        self._source = source

    async def __aiter__(self) -> AsyncIterator[responses.ResponseStreamEvent]:
        async for chunk in self._source:
            yield chunk
            if isinstance(chunk, responses.ResponseReasoningTextDeltaEvent):
                yield responses.ResponseReasoningSummaryTextDeltaEvent(
                    delta=chunk.delta,
                    item_id=chunk.item_id,
                    output_index=chunk.output_index,
                    sequence_number=chunk.sequence_number,
                    summary_index=0,
                    type="response.reasoning_summary_text.delta",
                )

    async def close(self) -> None:
        await self._source.close()


class RawReasoningResponsesModel(OpenAIResponsesModel):
    """Responses 模型：把厂商流里的原始思维链当作可显示的思考正文。

    官方只把 summary 块写进 ThinkingPart.content，原始块只进 provider_details.raw_content；
    百炼这类厂商流式只发原始块，照官方行为思考正文到不了前端。补出来的 summary 块与原始块
    同 id，官方会合进同一个 ThinkingPart——raw_content 因此照旧保留，不能只替换不保留：
    回传厂商时靠它判断，丢了思考会被包成 ``<think>`` 标签的 assistant 文本发回去。
    """

    async def _process_streamed_response(
        self,
        response: AsyncStream[responses.ResponseStreamEvent],
        model_settings: OpenAIResponsesModelSettings,
        model_request_parameters: ModelRequestParameters,
        *,
        expected_model_name: OpenAIModelName | None = None,
        expected_response_id: str | None = None,
    ) -> OpenAIResponsesStreamedResponse:
        wrapped = cast(
            "AsyncStream[responses.ResponseStreamEvent]", _RawReasoningAsSummary(response)
        )
        return await super()._process_streamed_response(
            wrapped,
            model_settings,
            model_request_parameters,
            expected_model_name=expected_model_name,
            expected_response_id=expected_response_id,
        )


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


def _model_settings(spec: ModelSpec) -> OpenAIChatModelSettings | None:
    if spec.thinking is None:
        return None
    # 不走官方统一的 thinking 字段：它要过厂商 profile 的 supports_thinking 那道门，
    # Qwen 的 profile 没开，值会被静默丢掉。reasoning_effort 不经那道门。
    return OpenAIChatModelSettings(openai_reasoning_effort=spec.thinking)


def build_model(spec: ModelSpec) -> Model:
    """造一个 ``Model``；provider 名非法或组合不成立即报错。"""

    provider = _build_provider(spec)
    settings = _model_settings(spec)
    if spec.api == "chat":
        # 模型类由官方按 provider 名决定：Ollama、OpenRouter 等各有专属类。
        picked = infer_model(f"{spec.provider}:{spec.model}", provider_factory=lambda _: provider)
        if settings is None:
            return picked
        # 官方的分派入口不收 settings，按它选出的类再造一次。
        return cast(
            "Model", cast("Any", type(picked))(spec.model, provider=provider, settings=settings)
        )

    if not isinstance(provider.client, AsyncOpenAI):
        raise RuntimeError(
            f"模型 {spec.name}：api: responses 只适用于 OpenAI 兼容的 provider，"
            f"{spec.provider} 不是"
        )
    return RawReasoningResponsesModel(spec.model, provider=provider, settings=settings)


def build_models(specs: Sequence[ModelSpec]) -> BuiltModels:
    """按名字造出全部模型；同名只造一个实例。"""

    return {spec.name: build_model(spec) for spec in specs}


__all__ = [
    "BuiltModels",
    "ModelApi",
    "ModelSpec",
    "RawReasoningResponsesModel",
    "ThinkingEffort",
    "build_model",
    "build_models",
]
