"""拿用户那句话换一个短标题。

不建 Agent：这是一次没有工具、不进 run 生命周期的模型调用，``direct.model_request`` 就是官方
给这种调用留的入口。挂 Agent 的话得连带背上历史、工具集与 usage 记账，一样都用不上。

**失败一律返回 None，不抛**。标题是锦上添花，起不出来对话照常能用；让它的异常冒到调用链上，
会把「这一轮跑完了」这件事拖下水。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

import structlog
from pydantic_ai import direct
from pydantic_ai.messages import ModelRequest, TextPart
from pydantic_ai.models import Model

_logger = structlog.stdlib.get_logger(__name__)

GenerateTitle = Callable[[str], Awaitable[str | None]]
"""一段用户输入 → 一个标题。起不出来给 None。"""

INSTRUCTIONS = """\
给这段对话起一个标题。

- 一行，不超过 20 个字，不加引号、句号或书名号。
- 说清这次要做的事，用对话里的具体名词（产品、场景、片型），不要「关于…的讨论」这种空壳。
- 用户用什么语言，标题就用什么语言。
- 只输出标题本身，不要任何解释。"""

MAX_INPUT_CHARS = 400
"""喂进去的用户原文截多长。照 kimi 的 MAX_TITLE_USER_SEGMENT。"""

MAX_TITLE_CHARS = 200
"""模型话多时截到这里。照 kimi 的 MAX_GENERATED_TITLE_LENGTH。"""


def title_generator(model: Model) -> GenerateTitle:
    """绑定一个模型，给出「一段话换一个标题」的函数。

    :param model: 起标题用的小模型。
    :returns: 起标题的函数。
    """

    async def generate(user_text: str) -> str | None:
        excerpt = user_text.strip()[:MAX_INPUT_CHARS]
        if not excerpt:
            return None
        try:
            response = await direct.model_request(
                model,
                [ModelRequest.user_text_prompt(excerpt, instructions=INSTRUCTIONS)],
            )
        except Exception:
            _logger.warning("起标题失败，这段对话先用默认名", exc_info=True)
            return None
        return clean_title(
            "".join(part.content for part in response.parts if isinstance(part, TextPart))
        )

    return generate


def clean_title(raw: str) -> str | None:
    """把模型的输出收成一个能上界面的标题；收不出东西给 None。

    模型偶尔会自作主张加引号、或者答成好几行。取第一行、剥掉成对的引号，就是标题。

    :param raw: 模型输出的原文。
    :returns: 标题；空的给 None。
    """

    line = raw.strip().splitlines()[0].strip() if raw.strip() else ""
    for quote in ('"', "'", "“", "”", "「", "」", "《", "》"):
        line = line.strip(quote)
    line = line.strip()[:MAX_TITLE_CHARS]
    return line or None


__all__ = ["GenerateTitle", "clean_title", "title_generator"]
