"""验证标题结果清理与生成失败时的降级行为。"""

from __future__ import annotations

import pytest
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from iclip.harness.titles import MAX_TITLE_CHARS, clean_title, title_generator

pytestmark = pytest.mark.unit


def _answering(text: str) -> FunctionModel:

    def script(_messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        return ModelResponse(parts=[TextPart(text)])

    return FunctionModel(script)


def _exploding() -> FunctionModel:
    """调用即抛出异常的模型替身。"""

    def script(_messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        raise RuntimeError("模型这会儿不干活")

    return FunctionModel(script)


async def test_模型答什么就是标题() -> None:
    generate = title_generator(_answering("夜景延时素材生成"))

    assert await generate("帮我做一条夜景延时的短片") == "夜景延时素材生成"


async def test_起标题只用最低思考档() -> None:
    seen: list[AgentInfo] = []

    def script(_messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        seen.append(info)
        return ModelResponse(parts=[TextPart("夜景延时素材生成")])

    await title_generator(FunctionModel(script))("帮我做一条夜景延时的短片")

    # 标题请求覆盖主模型的 high 设置，避免不必要的高强度推理。
    assert seen[0].model_settings is not None
    assert seen[0].model_settings.get("openai_reasoning_effort") == "low"


async def test_用户没打字就不叫模型() -> None:
    generate = title_generator(_exploding())

    # 图片消息无可用文本；异常模型可检测不应发生的模型调用。
    assert await generate("   ") is None


async def test_模型炸了不抛出去() -> None:
    generate = title_generator(_exploding())

    # 标题生成属于附加步骤，其异常不得影响主运行收尾。
    assert await generate("帮我做一条夜景延时的短片") is None


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ('"夜景延时素材生成"', "夜景延时素材生成"),
        ("「夜景延时素材生成」", "夜景延时素材生成"),
        ("夜景延时素材生成\n\n这个标题突出了…", "夜景延时素材生成"),
        ("  夜景延时素材生成  ", "夜景延时素材生成"),
        ("", None),
        ("\n\n", None),
    ],
)
def test_收拾模型的输出(raw: str, expected: str | None) -> None:
    assert clean_title(raw) == expected


def test_话太多的截断() -> None:
    cleaned = clean_title("镜" * (MAX_TITLE_CHARS + 50))

    assert cleaned is not None
    assert len(cleaned) == MAX_TITLE_CHARS
