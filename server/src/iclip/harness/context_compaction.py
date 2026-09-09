"""通过 CompactionPart 标记摘要边界，保留完整历史。

before_model_request 将边界写入历史；wrap_model_request 仅裁剪发往模型的窗口。
SummarizingCompaction 提供摘要和工具对完整的切点，触发条件由本模块控制。
摘要以 user 消息置于 instructions 之后，适配 Chat Completions。
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
    ModelRequestPart,
    ModelResponse,
    SystemPromptPart,
    UserPromptPart,
    post_compaction_window,
)
from pydantic_ai.models import ModelRequestContext
from pydantic_ai.tools import RunContext
from pydantic_ai_harness.compaction import SummarizingCompaction, estimate_context_tokens

_logger = structlog.stdlib.get_logger(__name__)

SUMMARY_FRAMING = (
    "The summary above is secondhand; re-verify critical facts against primary sources."
)
"""与 harness receipt 一致的摘要后续指令。"""


def compaction_boundary(message: ModelMessage) -> CompactionPart | None:
    """按 part 查找压缩边界，兼容框架合并相邻同角色消息后的历史。"""

    if not isinstance(message, ModelResponse):
        return None
    return next(
        (part for part in reversed(message.parts) if isinstance(part, CompactionPart)), None
    )


def compaction_only(message: ModelMessage) -> bool:
    """判断非空消息是否仅包含压缩边界；混有模型响应内容时仍计为一步。"""

    if not isinstance(message, ModelResponse) or not message.parts:
        return False
    return all(isinstance(part, CompactionPart) for part in message.parts)


def model_window(messages: Sequence[ModelMessage]) -> list[ModelMessage]:
    """返回最新边界后的模型窗口。摘要使用 user 消息，确保位于 instructions 之后。"""

    return _window(
        messages,
        lambda summary: UserPromptPart(content=f"{summary}\n\n{SUMMARY_FRAMING}"),
    )


def summarizer_input(messages: Sequence[ModelMessage]) -> list[ModelMessage]:
    """为摘要器构造窗口，使用带其约定前缀的 system part 标记旧摘要，以支持增量更新。"""

    return _window(messages, lambda summary: SystemPromptPart(content=summary))


def _window(
    messages: Sequence[ModelMessage], head_part: Callable[[str], ModelRequestPart]
) -> list[ModelMessage]:
    """按 part 级边界提取窗口，保留同一消息中边界之后的内容，并在前方插入摘要请求。"""

    window = post_compaction_window(messages)
    if not window or not isinstance(head := window[0], ModelResponse) or not head.parts:
        return window
    if not isinstance(part := head.parts[0], CompactionPart):
        return window
    rest = dataclasses.replace(head, parts=list(head.parts[1:]))
    return [
        ModelRequest(parts=[head_part(part.content or "")]),
        *([rest] if rest.parts else []),
        *window[1:],
    ]


@dataclass
class ContextCompaction(AbstractCapability[Any]):
    """历史超过阈值时写入压缩边界，后续请求使用边界后的窗口。"""

    strategy: SummarizingCompaction[Any]
    """仅调用摘要能力，由本模块控制触发。"""

    max_tokens: int
    """模型上下文窗口乘以压缩比例。"""

    on_compaction: Callable[[str], None]
    """压缩完成后通知运行侧更新显示。"""

    async def before_model_request(
        self, ctx: RunContext[Any], request_context: ModelRequestContext
    ) -> ModelRequestContext:
        """超过阈值时插入摘要边界；最近响应的 input_tokens 对应上次实际发送的窗口。"""

        messages = request_context.messages
        if (
            estimate_context_tokens(
                messages, model_request_parameters=request_context.model_request_parameters
            )
            <= self.max_tokens
        ):
            return request_context

        window = summarizer_input(messages)
        result = await self.strategy.compact(window, ctx)
        if result is window:
            # 保留尾部消息后，没有可摘要的内容。
            _logger.info("历史超线但切不动，这次不压", run_id=ctx.run_id, messages=len(messages))
            return request_context

        summary = _summary_of(result[0])
        index = _cut_index(messages, result[1:])
        boundary = ModelResponse(
            parts=[CompactionPart(content=summary, provider_name=ctx.model.system)],
            # 使用切点消息的 run_id；框架合并时保留前一消息的 id，避免历史响应被归入当前轮。
            run_id=messages[index].run_id if index < len(messages) else ctx.run_id,
            # 显式记录时间；框架仅为末条请求补充运行元数据。
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
        """复制请求 context 并替换为模型窗口，保持完整历史不变。"""

        return await handler(
            dataclasses.replace(request_context, messages=model_window(request_context.messages))
        )


def _summary_of(message: ModelMessage) -> str:
    """提取摘要器首条请求末尾的摘要 part；结构不符时抛错，避免空摘要遮蔽历史。"""

    last = message.parts[-1] if isinstance(message, ModelRequest) and message.parts else None
    if not isinstance(last, SystemPromptPart):
        raise RuntimeError(f"摘要器给的首条消息不是摘要请求：{message!r}")
    return last.content


def _cut_index(messages: Sequence[ModelMessage], preserved: Sequence[ModelMessage]) -> int:
    """按对象身份定位首条保留消息；跳过窗口拆分产生的新对象，避免相等消息误匹配。"""

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
    "summarizer_input",
]
