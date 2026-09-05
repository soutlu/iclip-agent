"""子代理的 transcript：父侧把 delegate_task 与子运行对上号，子侧把子运行镜像成独立一条流。

子代理的 agent id 就是它落库的 run id，轮 id 恒为 t1；父工具卡与子运行的关联记在官方工具账本里，
实时与历史两条路都据此重建。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from contextvars import ContextVar
from dataclasses import dataclass, replace
from functools import partial
from typing import Any

import structlog
from pydantic_ai.capabilities import (
    AbstractCapability,
    ValidatedToolArgs,
    WrapRunHandler,
    WrapToolExecuteHandler,
)
from pydantic_ai.exceptions import RunCancelled
from pydantic_ai.messages import AgentStreamEvent, ToolCallPart
from pydantic_ai.run import AgentRunResult, AgentRunResultEvent
from pydantic_ai.tools import RunContext, ToolDefinition
from pydantic_ai.ui import NativeEvent
from pydantic_ai_harness.step_persistence import StepStore, annotate_tool_effect

from iclip.harness.transcript.projector import TranscriptEventStream
from iclip.harness.transcript.store import TranscriptStore
from iclip.platform.transcript.display import ToolDisplayRegistry
from iclip.platform.transcript.ops import MAIN_AGENT_ID, TextContent

_logger = structlog.stdlib.get_logger(__name__)

CHILD_TURN_ID = "t1"
"""子代理一次运行就是一轮，轮 id 与序号都固定。"""

_DRAIN_SECONDS = 5.0
"""等镜像收流的上限；超时说明投影任务卡住了，宁可报错也不挂住父运行。"""


@dataclass(slots=True)
class Delegation:
    """一次 delegate_task 从父侧带给子运行的上下文；子侧回填 child_run_id。

    必须可变：子运行在自己的 Task 里跑，contextvar 是复制下去的，子侧 set() 回不到父侧，
    只有改同一个对象父侧才看得见。
    """

    conversation_id: str
    parent_agent_id: str
    tool_call_id: str
    on_spawn: Callable[[str, str], None]
    """子运行开跑时回调 (child_run_id, agent_name)，由父侧写自己那条流。"""
    child_run_id: str | None = None


current_delegation: ContextVar[Delegation | None] = ContextVar(
    "iclip.subagents.current_delegation", default=None
)


@dataclass(frozen=True, slots=True)
class _End:
    """子运行正常收尾，投影器可以收流。"""


@dataclass(frozen=True, slots=True)
class _Raise:
    """把子运行的异常送进投影器，让它走自己的失败或取消收尾。"""

    error: BaseException


_Item = AgentStreamEvent | AgentRunResultEvent[Any] | _End | _Raise


@dataclass(kw_only=True)
class SubAgentBridge(AbstractCapability[Any]):
    """父运行侧：每次 delegate_task 都把派出的子运行记进账本，并给父工具卡补上 agentRefs。"""

    store: StepStore
    live: TranscriptStore
    conversation_id: str
    projector: TranscriptEventStream
    delegate_tool: str
    parent_agent_id: str = MAIN_AGENT_ID

    async def wrap_tool_execute(
        self,
        ctx: RunContext[Any],
        *,
        call: ToolCallPart,
        tool_def: ToolDefinition,
        args: ValidatedToolArgs,
        handler: WrapToolExecuteHandler,
    ) -> Any:
        if tool_def.name != self.delegate_tool:
            return await handler(args)
        delegation = Delegation(
            conversation_id=self.conversation_id,
            parent_agent_id=self.parent_agent_id,
            tool_call_id=call.tool_call_id,
            on_spawn=partial(self._spawned, call.tool_call_id),
        )
        token = current_delegation.set(delegation)
        try:
            return await handler(args)
        finally:
            current_delegation.reset(token)
            await self._settle(ctx, call=call, tool_def=tool_def, delegation=delegation)

    def _spawned(self, tool_call_id: str, child_run_id: str, agent_name: str) -> None:
        """子运行开跑：父流上的那张卡认领它，并开一条 subagent 任务。"""

        self.live.append(
            self.conversation_id,
            self.parent_agent_id,
            self.projector.note_subagent(tool_call_id, child_run_id, agent_name),
        )

    async def _settle(
        self,
        ctx: RunContext[Any],
        *,
        call: ToolCallPart,
        tool_def: ToolDefinition,
        delegation: Delegation,
    ) -> None:
        """把子运行 id 写进工具账本，并在子快照落库后交接子流的实时状态。"""

        child_run_id = delegation.child_run_id
        if child_run_id is None:
            return
        # annotate_tool_effect 按 ctx 上的工具身份找记录，工具钩子之外的 ctx 不带这两个字段。
        scoped = (
            ctx
            if ctx.tool_call_id is not None and ctx.tool_name is not None
            else replace(ctx, tool_call_id=call.tool_call_id, tool_name=tool_def.name)
        )
        await annotate_tool_effect(self.store, scoped, effect_summary=child_run_id)
        _logger.debug("子代理已记入账本", tool_call_id=call.tool_call_id, child_run_id=child_run_id)
        if await self.store.latest_snapshot(run_id=child_run_id) is None:
            _logger.warning("子代理那一轮还没落进快照，先留在实时状态里", child_run_id=child_run_id)
            return
        self.live.mark_snapshot_persisted(self.conversation_id, child_run_id, CHILD_TURN_ID)
        self.live.drop_persisted_turns(self.conversation_id, child_run_id)


@dataclass(kw_only=True)
class SubAgentMirror(AbstractCapability[Any]):
    """子运行侧：把这次子运行投影成它自己那条 transcript 流。

    启动期构造一次，挂在 SubAgents.shared_capabilities 上；每次运行的状态都在 for_run 的副本上。
    """

    id: str | None = "subagent_mirror"
    live: TranscriptStore
    display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY
    _delegation: Delegation | None = None
    _queue: asyncio.Queue[_Item] | None = None

    async def for_run(self, ctx: RunContext[Any]) -> AbstractCapability[Any]:
        """按运行取一份副本；不是被 delegate 起的运行拿不到 delegation，所有钩子直通。"""

        return replace(self, _delegation=current_delegation.get(), _queue=asyncio.Queue[_Item]())

    async def wrap_run(
        self, ctx: RunContext[Any], *, handler: WrapRunHandler
    ) -> AgentRunResult[Any]:
        queue = self._queue
        delegation = self._delegation
        if delegation is None or queue is None:
            return await handler()
        child_run_id = ctx.run_id
        if child_run_id is None:
            raise RuntimeError("子代理这次运行没有 run id，镜像不了")
        agent_name = None if ctx.agent is None else ctx.agent.name
        if agent_name is None:
            raise RuntimeError("子代理没有名字，镜像不了")
        task = ctx.prompt
        if not isinstance(task, str):
            raise RuntimeError("子代理的 prompt 不是纯文本")
        delegation.child_run_id = child_run_id
        delegation.on_spawn(child_run_id, agent_name)
        projector = TranscriptEventStream(
            agent_id=child_run_id,
            turn_id=CHILD_TURN_ID,
            turn_ordinal=1,
            run_id=child_run_id,
            content=(TextContent(text=task),),
            display=self.display,
        )
        consumer = asyncio.create_task(
            self._mirror(queue, projector, delegation.conversation_id, child_run_id)
        )
        try:
            result = await handler()
        except asyncio.CancelledError:
            queue.put_nowait(_Raise(RunCancelled("子代理被停止")))
            raise
        except Exception as error:
            queue.put_nowait(_Raise(error))
            raise
        else:
            # 结果事件带着用量与完整历史，投影器靠它补步骤用量。
            queue.put_nowait(AgentRunResultEvent(result=result))
            queue.put_nowait(_End())
            return result
        finally:
            await asyncio.shield(asyncio.wait_for(consumer, _DRAIN_SECONDS))

    async def on_event(self, ctx: RunContext[Any], *, event: AgentStreamEvent) -> None:
        """把子运行的事件递给镜像任务；覆写这个钩子同时让 agent.run 开流式。"""

        if self._queue is not None and self._delegation is not None:
            self._queue.put_nowait(event)

    async def _mirror(
        self,
        queue: asyncio.Queue[_Item],
        projector: TranscriptEventStream,
        conversation_id: str,
        child_run_id: str,
    ) -> None:
        async for batch in projector.transform_stream(_drain(queue)):
            self.live.append(conversation_id, child_run_id, batch)


async def _drain(queue: asyncio.Queue[_Item]) -> AsyncIterator[NativeEvent]:
    """把队列变成投影器要的事件流；异常按原样抛出，交给它自己的失败与取消收尾。"""

    while True:
        item = await queue.get()
        match item:
            case _End():
                return
            case _Raise():
                raise item.error
            case _:
                yield item


__all__ = [
    "CHILD_TURN_ID",
    "Delegation",
    "SubAgentBridge",
    "SubAgentMirror",
    "current_delegation",
]
