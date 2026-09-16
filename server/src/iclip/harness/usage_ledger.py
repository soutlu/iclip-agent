"""对话用量台账：模型每答一次，把这次的 token 累加到（对话，模型）一行上。"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

import structlog
from pydantic_ai.capabilities import (
    AbstractCapability,
    CapabilityOrdering,
    WrapModelRequestHandler,
)
from pydantic_ai.messages import ModelResponse
from pydantic_ai.models import ModelRequestContext
from pydantic_ai.tools import RunContext

from iclip.harness.transcript.from_messages import step_usage
from iclip.platform.transcript.ops import StepUsage

_logger = structlog.stdlib.get_logger(__name__)

ConversationOf = Callable[[object], str | None]
"""从运行依赖（``ctx.deps``）取这次运行归属的对话 id；取不到返回 None，这次响应不记账。

子代理的 ``ctx.conversation_id`` 会重生成，只有依赖里继承的那份稳定，所以不看 ctx 自己的。"""


class ConversationUsageStore(Protocol):
    """台账存储：把一次响应的用量加到（对话，模型）那一行，没有就建。"""

    async def add(self, *, conversation_id: str, model_name: str, usage: StepUsage) -> None: ...


@dataclass
class UsageLedger(AbstractCapability[Any]):
    """在模型请求链最内层记账，外层 capability 拒掉的响应也已计入。

    写台账失败只记日志，不让已经付费的响应作废。
    """

    store: ConversationUsageStore
    conversation_of: ConversationOf

    def get_ordering(self) -> CapabilityOrdering:
        return CapabilityOrdering(position="innermost")

    async def wrap_model_request(
        self,
        ctx: RunContext[Any],
        *,
        request_context: ModelRequestContext,
        handler: WrapModelRequestHandler,
    ) -> ModelResponse:
        response = await handler(request_context)
        await self._record(ctx, response)
        return response

    async def _record(self, ctx: RunContext[Any], response: ModelResponse) -> None:
        conversation_id = self.conversation_of(ctx.deps)
        if conversation_id is None:
            _logger.warning("响应没有归属对话，用量不记账", run_id=ctx.run_id)
            return
        usage = step_usage(response.usage)
        if usage is None:
            return
        # 用配置里的模型 id，与子代理档案记的同一个名字；provider 回报的名字可能带版本后缀。
        model_name = ctx.model.model_name
        try:
            await self.store.add(
                conversation_id=conversation_id, model_name=model_name, usage=usage
            )
        except Exception:
            _logger.error(
                "用量台账写入失败",
                run_id=ctx.run_id,
                conversation_id=conversation_id,
                model_name=model_name,
                exc_info=True,
            )


__all__ = ["ConversationOf", "ConversationUsageStore", "UsageLedger"]
