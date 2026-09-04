"""上下文压缩：摘要作为一条边界留在历史里，发给模型的窗口在发送时现算。

核心库自己就是这个模型——``CompactionPart`` 标出「这之前的都被摘要顶掉了」，全量历史一条不删，
模型看到的那段由 ``post_compaction_window`` 从最后一条边界往后推。缺的只有两段：核心库只在厂商
自己返回边界时产生它，而我们用的 Chat Completions 适配器在发送时把 ``CompactionPart`` 直接丢掉。
两段都补在公开 hook 上：

- ``before_model_request`` 产生边界。这个 hook 的改动按框架设计写回 run 历史，所以边界落得进去。
- ``wrap_model_request`` 算窗口。它只影响交给 handler 的那一次请求，不写回历史，快照因此仍是全量。

摘要本身借 harness 的 ``SummarizingCompaction`` 当黑盒用：它有调好的 prompt、增量更新与不拆工具
对的切点。它自己的触发不挂。
"""

from __future__ import annotations

import dataclasses
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import structlog
from pydantic_ai.capabilities import AbstractCapability, WrapModelRequestHandler
from pydantic_ai.messages import (
    CompactionPart,
    ModelMessage,
    ModelRequest,
    ModelResponse,
    SystemPromptPart,
    post_compaction_window,
)
from pydantic_ai.models import ModelRequestContext
from pydantic_ai.tools import RunContext
from pydantic_ai_harness.compaction import SummarizingCompaction, estimate_context_tokens

_logger = structlog.stdlib.get_logger(__name__)

SUMMARY_FRAMING = (
    "The summary above is secondhand; re-verify critical facts against primary sources."
)
"""摘要之后补的一句话，逐字取 harness receipt 里那句。"""


def compaction_boundary(message: ModelMessage) -> CompactionPart | None:
    """这条消息带着一条压缩边界时，返回那个 part。

    按 part 认，不按整条认：刚插进去时边界自成一条消息，但这份历史再被当成 ``message_history``
    交回引擎时，框架会把相邻的同角色消息并成一条，边界从此和旁边那次响应挤在一起。按整条认的话
    界面上那块提示在下一轮之后就没了，而且不报错。
    """

    if not isinstance(message, ModelResponse):
        return None
    return next(
        (part for part in reversed(message.parts) if isinstance(part, CompactionPart)), None
    )


def compaction_only(message: ModelMessage) -> bool:
    """这条消息除了边界什么都没有——它不是模型答的一步。

    并进别的响应之后就不再成立：那条消息里还有模型真说过的话，它照样是一步。

    ``parts`` 空的响应在真实历史里存在，而 ``all()`` 对空列表为真，所以先要求它非空。
    """

    if not isinstance(message, ModelResponse) or not message.parts:
        return False
    return all(isinstance(part, CompactionPart) for part in message.parts)


def model_window(messages: Sequence[ModelMessage]) -> list[ModelMessage]:
    """这份历史此刻该发给模型的那一段：最后一条边界之后的全部消息，前面顶一条摘要请求。

    切点由核心库的 ``post_compaction_window`` 给，它认的是 part 级的位置而不是整条消息：
    框架在发送前会把相邻的同角色消息并成一条，边界因此常常和旁边那次响应挤在一条里，按整条
    认就再也找不着它，窗口悄悄退回整份历史。同一条消息里排在边界后面的 part 仍属于窗口。

    摘要与那句提醒分成两个 part，不拼成一段：摘要器认上一份摘要靠的是「以固定前缀开头的
    system part」，拼上别的字它就认不出来，增量更新退化成对摘要再摘要。
    """

    window = post_compaction_window(messages)
    head = window[0] if window else None
    part = head.parts[0] if isinstance(head, ModelResponse) and head.parts else None
    if not isinstance(part, CompactionPart):
        return window
    kept = list(head.parts[1:]) if isinstance(head, ModelResponse) else []
    return [
        ModelRequest(
            parts=[
                SystemPromptPart(content=part.content or ""),
                SystemPromptPart(content=SUMMARY_FRAMING),
            ]
        ),
        *([dataclasses.replace(head, parts=kept)] if kept and head is not None else []),
        *window[1:],
    ]


@dataclass
class ContextCompaction(AbstractCapability[Any]):
    """历史超过触发线时压一次：在切点插一条边界，之后每次请求只发边界之后那一段。"""

    strategy: SummarizingCompaction[Any]
    """只当摘要器用，它自己的触发从不调用。"""

    max_tokens: int
    """触发线，由运行侧按模型窗口乘比例算好。"""

    on_compaction: Callable[[str], None]
    """压缩发生时把摘要正文交给运行侧，界面据此画一块提示。"""

    async def before_model_request(
        self, ctx: RunContext[Any], request_context: ModelRequestContext
    ) -> ModelRequestContext:
        """超过触发线就压一次，边界插在切点上。

        用量估算锚在最近一条响应的 ``input_tokens`` 上，而那个数量正是上次实际发出去的窗口，
        所以在全量历史上算出来的也是窗口的大小。
        """

        messages = request_context.messages
        if (
            estimate_context_tokens(
                messages, model_request_parameters=request_context.model_request_parameters
            )
            <= self.max_tokens
        ):
            return request_context

        window = model_window(messages)
        result = await self.strategy.compact(window, ctx)
        if result is window:
            # 切不动：消息少到留够尾巴就没剩下可摘要的了。
            _logger.info("历史超线但切不动，这次不压", run_id=ctx.run_id, messages=len(messages))
            return request_context

        summary = _summary_of(result[0])
        index = _cut_index(messages, result[1:])
        boundary = ModelResponse(
            parts=[CompactionPart(content=summary, provider_name=ctx.model.system)],
            # 盖切点那条消息的号，不盖本次 run 的：这份历史下次交回引擎时，框架会把边界并进它后面
            # 那条响应，而合并保留前一条的号。盖本次 run 的话，那条响应连同它那一步会被拽进本轮，
            # 早就跑完的那一轮当场空掉一步。
            run_id=messages[index].run_id if index < len(messages) else ctx.run_id,
            # 时刻自己盖：框架的 run 元数据只盖末条请求，不盖中途插进来的消息。
            timestamp=datetime.now(UTC),
        )
        _logger.info(
            "历史压成摘要",
            run_id=ctx.run_id,
            boundary_index=index,
            messages_before=len(messages),
        )
        messages.insert(index, boundary)
        self.on_compaction(summary)
        return request_context

    async def wrap_model_request(
        self,
        ctx: RunContext[Any],
        *,
        request_context: ModelRequestContext,
        handler: WrapModelRequestHandler,
    ) -> ModelResponse:
        """只把窗口交给这一次请求。换一份 context 而不是原地改：改了就写进历史了。"""

        return await handler(
            dataclasses.replace(request_context, messages=model_window(request_context.messages))
        )


def _summary_of(message: ModelMessage) -> str:
    """摘要器把新摘要放在首条请求的最后一个 part，它前面可能还带着原有的 system prompt。

    形状对不上就是摘要器换了写法，当场抛出来——拿一段空摘要插条边界的话，边界之前那段历史
    就此从模型眼里消失，而且不报错。
    """

    last = message.parts[-1] if isinstance(message, ModelRequest) and message.parts else None
    if not isinstance(last, SystemPromptPart):
        raise RuntimeError(f"摘要器给的首条消息不是摘要请求：{message!r}")
    return last.content


def _cut_index(messages: Sequence[ModelMessage], preserved: Sequence[ModelMessage]) -> int:
    """切点在原列表里的位置：留下来那几条中，头一条在原列表里的下标。

    按对象身份找，不按相等找：消息之间字段相等是常事（两条一样的空请求），``list.index`` 会指到
    别处去。逐条找而不是只找 ``preserved[0]``：窗口首条可能是 ``model_window`` 现造的那半条
    （边界与模型的话挤在同一条时，排在边界后面的 part 被拆出来），它压根不在原列表里。
    """

    alive = {id(item) for item in preserved}
    return next(
        (index for index, message in enumerate(messages) if id(message) in alive), len(messages)
    )


__all__ = [
    "SUMMARY_FRAMING",
    "ContextCompaction",
    "compaction_boundary",
    "compaction_only",
    "model_window",
]
