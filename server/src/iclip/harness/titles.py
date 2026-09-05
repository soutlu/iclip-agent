"""通过 direct.model_request 生成会话标题，不建立工具运行或历史。

失败返回 None，不影响主运行的完成状态。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

import structlog
from pydantic_ai import direct
from pydantic_ai.messages import ModelRequest, TextPart
from pydantic_ai.models import Model
from pydantic_ai.models.openai import OpenAIChatModelSettings

_logger = structlog.stdlib.get_logger(__name__)

TITLE_SETTINGS = OpenAIChatModelSettings(openai_reasoning_effort="low")
"""显式覆盖模型级思考设置；GLM-5.3-Flash 的最低可用档位为 low。"""

GenerateTitle = Callable[[str], Awaitable[str | None]]
"""从用户输入生成标题，失败返回 None。"""

INSTRUCTIONS = """\
给这段对话起一个标题。

- 一行，不超过 20 个字，不加引号、句号或书名号。
- 说清这次要做的事，用对话里的具体名词（产品、场景、片型），不要「关于…的讨论」这种空壳。
- 用户用什么语言，标题就用什么语言。
- 只输出标题本身，不要任何解释。"""

MAX_INPUT_CHARS = 400
"""标题生成输入的字符上限。"""

MAX_TITLE_CHARS = 200
"""生成标题的字符上限。"""


def title_generator(model: Model) -> GenerateTitle:
    """绑定模型并返回标题生成函数。"""

    async def generate(user_text: str) -> str | None:
        excerpt = user_text.strip()[:MAX_INPUT_CHARS]
        if not excerpt:
            return None
        try:
            response = await direct.model_request(
                model,
                [ModelRequest.user_text_prompt(excerpt, instructions=INSTRUCTIONS)],
                model_settings=TITLE_SETTINGS,
            )
        except Exception:
            _logger.warning("起标题失败，这段对话先用默认名", exc_info=True)
            return None
        return clean_title(
            "".join(part.content for part in response.parts if isinstance(part, TextPart))
        )

    return generate


def clean_title(raw: str) -> str | None:
    """取首行并移除成对引号，生成可显示标题；空结果返回 None。"""

    line = raw.strip().splitlines()[0].strip() if raw.strip() else ""
    for quote in ('"', "'", "“", "”", "「", "」", "《", "》"):
        line = line.strip(quote)
    line = line.strip()[:MAX_TITLE_CHARS]
    return line or None


__all__ = ["GenerateTitle", "clean_title", "title_generator"]
