"""后台运行与可重放的事件流。

一次运行的事件只往 Redis 里写，不绑在发起它的那个 HTTP 请求上。于是：

- 客户端断开只是没人读了，运行照跑到底，结果照样落库；
- 重新连上来时从上次读到的位置接着取，中间的事件不会丢；
- 多进程部署时，重连打到哪个进程都行——流是共享的，只有正在跑的那个任务待
  在起它的那个进程里。

进程要是没了，运行当然也就断了。这种情况不会假装跑完：生产者留的存活标记一
过期，读的人就往流里写一帧「中断了，可以重试」的错误事件收尾。
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass

from ag_ui.core import RunErrorEvent
from ag_ui.encoder import EventEncoder

from iclip.common.errors import Conflict, NotFound, ValidationFailed
from iclip.harness.agents import AgentRegistry
from iclip.harness.run_stream_redis import STREAM_START, RunFrame, RunStream

INTERRUPTED_CODE = "RUN_INTERRUPTED"
"""收尾用的错误码：运行没跑完就断了，客户端可以重新发起。"""

_SSE = EventEncoder(accept="text/event-stream")
_RUN_ID = re.compile(r"[A-Za-z0-9._-]{1,128}")
_CURSOR = re.compile(r"\d{1,20}-\d{1,20}")


@dataclass(frozen=True, slots=True)
class RunStreamSettings:
    """事件流的时间与容量约定。"""

    lease_seconds: float = 30.0
    heartbeat_seconds: float = 10.0
    block_ms: int = 5_000
    replay_window_seconds: int = 3_600
    max_frames: int = 100_000


def _sse(frame: RunFrame) -> str:
    """把一帧包成带位置的 SSE 事件。

    ``id:`` 里放的就是它在流里的位置。客户端断线重连时把最后收到的 id 报回
    来（标准 SSE 的 ``Last-Event-ID`` 头），我们就从那儿接着发。
    """

    return f"id: {frame.cursor}\n{frame.text}"


def _error_frame(message: str) -> str:
    return _SSE.encode(RunErrorEvent(message=message, code=INTERRUPTED_CODE))


class RunBroker:
    """把「跑一次运行」和「读它的事件」拆成两件事。

    ``open`` 确保后台有个任务在跑；``feed`` 只负责读。两者之间除了 Redis 里
    那条流没有别的联系，所以读的人来了又走都不影响跑的人。
    """

    def __init__(
        self,
        registry: AgentRegistry,
        stream: RunStream,
        settings: RunStreamSettings | None = None,
    ) -> None:
        self._registry = registry
        self._stream = stream
        self._settings = settings or RunStreamSettings()
        # 拿住任务的引用。asyncio 只弱引用运行中的任务，不存着的话跑一半可能
        # 被垃圾回收掉。
        self._producers: set[asyncio.Task[None]] = set()

    def _run_key(self, owner: str, agent_id: str, run_id: str) -> str:
        """给这次运行在 Redis 里定个名字。

        名字里带上是谁的运行。运行 id 是客户端自己起的，带上归属之后它就只是
        「这个用户自己那一摊里的一个名字」，猜别人的 id 也落不到别人的流上。
        """

        if not _RUN_ID.fullmatch(run_id):
            raise ValidationFailed(
                "运行 id 只能是字母、数字、点、下划线、短横线，且不超过 128 字符"
            )
        return f"{owner}:{agent_id}:{run_id}"

    async def open(
        self, *, owner: str, agent_id: str, body: bytes, deps: Callable[[str], object]
    ) -> str:
        """发起一次运行，返回它在流里的名字。

        同一个运行 id 再来一次不会重复跑：抢不到生产权就说明已经有人在跑（或
        者刚跑完、事件还在重放窗口里），这次调用只是把名字算出来给人去读。

        未注册的 agent 与不合协议的请求体都在这里就抛出来，还没开始流。

        ``deps`` 是造依赖的函数（注册表解析出会话 id 后回调它），返回类型写
        ``object`` 并且全程不解包——这一层不认识业务，它只负责把东西送到官方接口
        手上。``owner`` 不能拿它来推：那是流名字的归属段，得是个字符串。

        一次运行被判中断（生产者没留下结局）后客户端重发，那是**一次新的运行、
        新捕获一次身份**——用重发者当时的主体，不去把上一次的身份从什么地方复
        活。也没有可复活的地方：谁跑的那次运行并没有落库（见 architecture.md
        §7 的表结构），而进程内存里的东西不是可信事实源。
        """

        handle = self._registry.start(agent_id, body, deps)
        run_key = self._run_key(owner, agent_id, handle.run_id)
        if await self._stream.claim(run_key, lease_seconds=self._settings.lease_seconds):
            task = asyncio.create_task(self._produce(run_key, handle.frames))
            self._producers.add(task)
            task.add_done_callback(self._producers.discard)
        # 抢不到就把 handle 丢掉。它的帧流是个还没开始跑的生成器，一帧都没产
        # 生过，丢掉不会留下任何东西。
        return run_key

    def locate(self, *, owner: str, agent_id: str, run_id: str) -> str:
        """算出一次已有运行在流里的名字（重连时用）。"""

        if agent_id not in self._registry.ids:
            raise NotFound(f"未注册的 agent: {agent_id}")
        return self._run_key(owner, agent_id, run_id)

    async def feed(self, run_key: str, *, after: str | None) -> AsyncIterator[str]:
        """读这次运行的事件，``after`` 是上次读到的位置（``None`` 即从头）。

        流里没帧、这个名字下也没有任何阶段记录，说明什么都没有：从头读是「没有
        这次运行」，带着位置来读是「它跑过，但重放窗口已经过去了」——后者得告
        诉客户端重新发起，不能默默跳到当前位置假装接上了。

        位置的形状在这里就校验掉。它来自客户端，形状不对就得当场拒绝：真拿去
        问 Redis 的话，报错会在响应头已经发出去之后才在流中途爆开。
        """

        if after is not None and not _CURSOR.fullmatch(after):
            raise ValidationFailed("位置的形状不对，应当原样回传上一帧的 id")
        if not await self._stream.exists(run_key) and await self._stream.state(run_key) == "gone":
            if after is None:
                raise NotFound("没有这次运行的事件流")
            raise Conflict("这次运行的事件已经过了重放窗口，接不上了，请重新发起运行")
        return self._read(run_key, after or STREAM_START)

    async def shutdown(self) -> None:
        """关停时取消所有后台生产者。

        取消之后不补终态帧：取消是在协程被打断的当口，这时再去 await 一次
        Redis 写入本身就不可靠。存活标记过期后由读的人收尾——和进程被杀走的
        是同一条路，少一条只在优雅关停时才走的分支。
        """

        producers = tuple(self._producers)
        for task in producers:
            task.cancel()
        await asyncio.gather(*producers, return_exceptions=True)

    async def _read(self, run_key: str, after: str) -> AsyncIterator[str]:
        cursor = after
        while True:
            frames = await self._stream.read(
                run_key, after=cursor, block_ms=self._settings.block_ms
            )
            if not frames:
                state = await self._stream.state(run_key)
                if state == "live":
                    continue  # 还有人在写，接着等
                # 没人在写了。可能是它刚写完最后一帧就撒手，所以先补读一次。
                frames = await self._stream.read(run_key, after=cursor, block_ms=None)
                if not frames:
                    if state == "done":
                        # 结局早就在流里，这次只是从末尾之后开始读的，没有新东西
                        # 可发了。就此收流，不要凭空造一个事件。
                        return
                    yield _sse(await self._interrupt(run_key))
                    return
            for frame in frames:
                cursor = frame.cursor
                yield _sse(frame)
                if frame.last:
                    return

    async def _interrupt(self, run_key: str) -> RunFrame:
        """把「中断了，可以重试」写进流，并给这条流定下重放窗口。

        写进流而不是只发给当前这个读者，是为了让所有人看到同一个结局。两个读
        者同时收尾也没关系：读的人认第一帧终帧，多出来的那帧没人会看到。绝不
        编造一个跑完了的结局——那会让客户端以为拿到了完整结果。

        收尾也要定窗口。不然进程每崩一次就在 Redis 里留下一条永不过期的流。
        """

        frame = await self._stream.append(
            run_key, _error_frame("运行中断了，可以重新发起"), last=True
        )
        await self._stream.finish(run_key, keep_seconds=self._settings.replay_window_seconds)
        return frame

    async def _produce(self, run_key: str, frames: AsyncIterator[tuple[str, bool]]) -> None:
        beat = asyncio.create_task(self._heartbeat(run_key))
        try:
            unfinished = await self._pump(run_key, frames)
        except Exception:
            # 先给客户端留下一个终态（顺带定下重放窗口），再把异常抛回 asyncio，
            # 让它照常打出完整堆栈——不吞掉故障，也不让读的人干等到租约过期。
            await self._interrupt(run_key)
            raise
        finally:
            beat.cancel()
        if unfinished is not None:
            await self._stream.append(run_key, _error_frame(unfinished), last=True)
        await self._stream.finish(run_key, keep_seconds=self._settings.replay_window_seconds)

    async def _pump(self, run_key: str, frames: AsyncIterator[tuple[str, bool]]) -> str | None:
        """把帧搬进流。

        返回 ``None`` 表示已经写进了终态帧；否则返回该补上的中断原因。
        """

        written = 0
        async for text, last in frames:
            written += 1
            if written > self._settings.max_frames:
                return (
                    f"这次运行的事件超过了 {self._settings.max_frames} 条上限，已中断，可以重新发起"
                )
            await self._stream.append(run_key, text, last=last)
            if last:
                return None
        return "运行结束时没有留下结局，可以重新发起"

    async def _heartbeat(self, run_key: str) -> None:
        """定期续存活标记。

        必须是独立任务，不能搭在写帧上：模型一次调用几十秒不出事件是常态，要
        是把续期挂在写帧的节奏上，一个活着的运行会被当成死的收尾，之后它写的
        帧还会落在终态帧后面。
        """

        while True:
            await asyncio.sleep(self._settings.heartbeat_seconds)
            await self._stream.renew(run_key, lease_seconds=self._settings.lease_seconds)


__all__ = ["INTERRUPTED_CODE", "RunBroker", "RunStreamSettings"]
