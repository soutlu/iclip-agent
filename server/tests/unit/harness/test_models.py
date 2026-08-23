"""命名模型装配契约：端点与 key 来自配置、chat/responses 分派、非法组合即失败。"""

from __future__ import annotations

from typing import cast

import pytest
from openai import AsyncOpenAI
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel

from iclip.harness.models import ModelApi, ModelSpec, build_model, build_models

BAILIAN = "https://dashscope.aliyuncs.com/compatible-mode/v1"


def spec(
    *,
    name: str = "qwen",
    provider: str = "alibaba",
    model: str = "qwen3.8-max",
    api: ModelApi = "chat",
    api_key: str = "sk-test",
    base_url: str | None = BAILIAN,
) -> ModelSpec:
    return ModelSpec(
        name=name,
        provider=provider,
        model=model,
        api=api,
        api_key=api_key,
        base_url=base_url,
    )


def test_chat_uses_official_dispatch_with_configured_endpoint() -> None:
    model = build_model(spec())

    assert isinstance(model, OpenAIChatModel)
    assert model.base_url.rstrip("/") == BAILIAN
    assert model.system == "alibaba"


def test_responses_api_selected_explicitly() -> None:
    """官方分派对 alibaba 默认给 chat，写了 responses 才切换。"""

    model = build_model(spec(api="responses"))

    assert isinstance(model, OpenAIResponsesModel)
    assert model.base_url.rstrip("/") == BAILIAN


def test_vendor_profile_survives_on_both_apis() -> None:
    """厂商适配在 chat / responses 两条路径上都要保留。"""

    for api in ("chat", "responses"):
        profile = dict(build_model(spec(api=api)).profile)
        transformer = cast("type[object]", profile["json_schema_transformer"])
        assert transformer.__name__ == "InlineDefsJsonSchemaTransformer"
        assert profile["supports_json_schema_output"] is False


def test_provider_without_base_url_param_still_gets_configured_endpoint() -> None:
    """deepseek 的构造函数不收 base_url，走 openai_client。"""

    model = build_model(spec(name="ds", provider="deepseek", model="deepseek-chat"))

    assert isinstance(model, OpenAIChatModel)
    assert model.base_url.rstrip("/") == BAILIAN


def test_base_url_absent_uses_provider_default() -> None:
    model = build_model(spec(base_url=None))

    assert (model.base_url or "").rstrip("/") == (
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
    )


def test_provider_owning_model_class_is_not_flattened() -> None:
    """有专属模型类的 provider 不得被拍平成 OpenAIChatModel。"""

    model = build_model(
        spec(name="local", provider="ollama", model="qwen3-8b", base_url="http://x/v1")
    )

    assert type(model).__name__ == "OllamaModel"


def test_unknown_provider_fails() -> None:
    with pytest.raises(Exception, match="no-such-vendor"):
        build_model(spec(provider="no-such-vendor"))


def test_responses_rejected_for_non_openai_provider() -> None:
    """非 OpenAI 兼容的 provider 写 responses 即报错。"""

    pytest.importorskip("anthropic")
    with pytest.raises(RuntimeError, match="只适用于 OpenAI 兼容"):
        build_model(spec(provider="anthropic", model="claude-x", api="responses", base_url=None))


def test_build_models_keys_by_name_and_reuses_instance() -> None:
    built = build_models([spec(), spec(name="ds", provider="deepseek", model="deepseek-chat")])

    assert sorted(built) == ["ds", "qwen"]
    assert isinstance(cast("OpenAIChatModel", built["qwen"]).client, AsyncOpenAI)
