"""命名模型装配契约：端点与 key 来自配置、chat/responses 分派、非法组合即失败。"""

from __future__ import annotations

import json
from typing import cast

import httpx2
import pytest
from openai import AsyncOpenAI
from pydantic_ai.messages import ModelRequest, ThinkingPart
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel
from pydantic_ai.providers.alibaba import AlibabaProvider

from iclip.harness.models import (
    ModelApi,
    ModelSpec,
    RawReasoningResponsesModel,
    ThinkingEffort,
    build_model,
    build_models,
)

BAILIAN = "https://dashscope.aliyuncs.com/compatible-mode/v1"


def spec(
    *,
    name: str = "qwen",
    provider: str = "alibaba",
    model: str = "qwen3.8-max",
    api: ModelApi = "chat",
    api_key: str = "sk-test",
    base_url: str | None = BAILIAN,
    thinking: ThinkingEffort | None = None,
) -> ModelSpec:
    return ModelSpec(
        name=name,
        provider=provider,
        model=model,
        api=api,
        api_key=api_key,
        base_url=base_url,
        thinking=thinking,
    )


def test_chat_uses_official_dispatch_with_configured_endpoint() -> None:
    model = build_model(spec())

    assert isinstance(model, OpenAIChatModel)
    assert model.base_url.rstrip("/") == BAILIAN
    assert model.system == "alibaba"


def test_responses_api_selected_explicitly() -> None:
    """alibaba 默认分派到 chat，responses 需显式配置。"""

    model = build_model(spec(api="responses"))

    assert isinstance(model, OpenAIResponsesModel)
    assert model.base_url.rstrip("/") == BAILIAN


def test_vendor_profile_survives_on_both_apis() -> None:

    for api in ("chat", "responses"):
        profile = dict(build_model(spec(api=api)).profile)
        transformer = cast("type[object]", profile["json_schema_transformer"])
        assert transformer.__name__ == "InlineDefsJsonSchemaTransformer"
        assert profile["supports_json_schema_output"] is False


def test_provider_without_base_url_param_still_gets_configured_endpoint() -> None:
    """deepseek 构造器不接受 base_url，通过 openai_client 传入端点。"""

    model = build_model(spec(name="ds", provider="deepseek", model="deepseek-chat"))

    assert isinstance(model, OpenAIChatModel)
    assert model.base_url.rstrip("/") == BAILIAN


def test_base_url_absent_uses_provider_default() -> None:
    model = build_model(spec(base_url=None))

    assert (model.base_url or "").rstrip("/") == (
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
    )


def test_provider_owning_model_class_is_not_flattened() -> None:

    model = build_model(
        spec(name="local", provider="ollama", model="qwen3-8b", base_url="http://x/v1")
    )

    assert type(model).__name__ == "OllamaModel"


def test_unknown_provider_fails() -> None:
    with pytest.raises(Exception, match="no-such-vendor"):
        build_model(spec(provider="no-such-vendor"))


def test_responses_rejected_for_non_openai_provider() -> None:

    pytest.importorskip("anthropic")
    with pytest.raises(RuntimeError, match="只适用于 OpenAI 兼容"):
        build_model(spec(provider="anthropic", model="claude-x", api="responses", base_url=None))


def test_build_models_keys_by_name_and_reuses_instance() -> None:
    built = build_models([spec(), spec(name="ds", provider="deepseek", model="deepseek-chat")])

    assert sorted(built) == ["ds", "qwen"]
    assert isinstance(cast("OpenAIChatModel", built["qwen"]).client, AsyncOpenAI)


def test_thinking_lands_in_model_settings_on_both_apis() -> None:
    """chat 分派入口不接受 settings，需额外构造模型并保持两种 API 设置一致。"""

    for api in ("chat", "responses"):
        model = build_model(spec(api=api, thinking="medium"))
        assert model.settings == {"openai_reasoning_effort": "medium"}
    assert isinstance(build_model(spec(api="chat", thinking="low")), OpenAIChatModel)
    assert build_model(spec()).settings is None


def _reasoning_stream() -> bytes:
    """模拟百炼流：原始思考为 reasoning_text，done 项携带 summary。"""

    reasoning_done = {
        "id": "msg_r",
        "type": "reasoning",
        "summary": [{"type": "summary_text", "text": "先想一想"}],
    }
    message_done = {
        "id": "msg_a",
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [{"type": "output_text", "text": "2", "annotations": []}],
    }
    base = {
        "id": "r1",
        "object": "response",
        "created_at": 1,
        "model": "qwen3.8-max",
        "parallel_tool_calls": False,
        "tool_choice": "auto",
        "tools": [],
    }
    reasoning_delta = {
        "type": "response.reasoning_text.delta",
        "output_index": 0,
        "item_id": "msg_r",
        "content_index": 0,
    }
    events: list[dict[str, object]] = [
        {"type": "response.created", "response": {**base, "status": "queued", "output": []}},
        {
            "type": "response.output_item.added",
            "output_index": 0,
            "item": {**reasoning_done, "summary": []},
        },
        {**reasoning_delta, "delta": "先想"},
        {**reasoning_delta, "delta": "一想"},
        {"type": "response.output_item.done", "output_index": 0, "item": reasoning_done},
        {
            "type": "response.output_item.added",
            "output_index": 1,
            "item": {**message_done, "content": []},
        },
        {
            "type": "response.output_text.delta",
            "output_index": 1,
            "item_id": "msg_a",
            "content_index": 0,
            "delta": "2",
        },
        {"type": "response.output_item.done", "output_index": 1, "item": message_done},
        {
            "type": "response.completed",
            "response": {
                **base,
                "status": "completed",
                "output": [reasoning_done, message_done],
                "usage": {
                    "input_tokens": 5,
                    "output_tokens": 3,
                    "total_tokens": 8,
                    "input_tokens_details": {"cached_tokens": 0},
                    "output_tokens_details": {"reasoning_tokens": 2},
                },
            },
        },
    ]
    frames = [
        f"event: {event['type']}\ndata: {json.dumps({**event, 'sequence_number': seq})}\n\n"
        for seq, event in enumerate(events)
    ]
    return "".join(frames).encode()


async def test_raw_reasoning_streams_as_thinking_content() -> None:
    """通过 SSE 解析覆盖覆写方法的兼容性，确认原始思考保存在 content 与回传用 raw_content 中。"""

    def serve(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            200, headers={"content-type": "text/event-stream"}, content=_reasoning_stream()
        )

    client = AsyncOpenAI(
        api_key="sk-test",
        base_url=BAILIAN,
        http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(serve)),
    )
    model = RawReasoningResponsesModel(
        "qwen3.8-max", provider=AlibabaProvider(openai_client=client)
    )

    async with model.request_stream(
        [ModelRequest.user_text_prompt("1+1=?")], None, ModelRequestParameters()
    ) as stream:
        async for _ in stream:
            pass
        response = stream.get()

    thinking = [part for part in response.parts if isinstance(part, ThinkingPart)]
    assert [part.content for part in thinking] == ["先想一想"]
    assert thinking[0].provider_details == {"raw_content": ["先想一想"]}
