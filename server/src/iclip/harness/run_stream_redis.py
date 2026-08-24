"""运行事件流的 Redis 后端：一次运行产生的帧按顺序进一个 Redis Stream。

这是 harness 环唯一碰 Redis 的文件，和 ``step_store_pg.py`` 唯一碰 SQL 是同
一个道理：外部存储的细节收在一处，别处只认协议。

本文件不认识 AG-UI，只搬字符串——一帧长什么样、哪一帧是最后一帧，都由调用
方说了算。它另外替这条流记一件事：**现在处于哪个阶段**。三个阶段各对应一种
处置：

- ``live``：有人正在写。写的人定期来续期，所以这个标记一直新鲜。
- ``done``：写完了，结局已经在流里。这个标记和流同寿命，重放窗口一过一起消失。
- ``gone``：什么都没有。要么从没跑过，要么写的人没留下结局就消失了（进程被杀）。

区分 ``done`` 和 ``gone`` 是必需的，不能合成一个「没人在写」：前者说明读者只是
读到了末尾，后者才是真出事了要收尾。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol, cast

from redis.asyncio import Redis
from redis.typing import EncodableT, FieldT

STREAM_START = "0-0"
"""从头开始读的位置。Redis 的位置是排他的，所以这个值能取到第一帧。"""

RunState = Literal["live", "done", "gone"]

_STREAM_PREFIX = "iclip:agent:run:"
_STATE_SUFFIX = ":state"
_FRAME_FIELD = "f"
_LAST_FIELD = "t"
_LIVE = "live"
_DONE = "done"


@dataclass(frozen=True, slots=True)
class RunFrame:
    """流里的一帧。

    ``cursor`` 是它在流里的位置，客户端断线重连时报回这个值就能接着读；
    ``last`` 标出这是不是最后一帧。
    """

    cursor: str
    text: str
    last: bool


class RunStream(Protocol):
    """一次运行的事件流：能往后写、能从任意位置重读、能看出它处在哪个阶段。"""

    async def claim(self, run_key: str, *, lease_seconds: float) -> bool:
        """抢下这次运行的生产权。

        只有 ``gone``（这个名字下什么都没有）才抢得到。已经在跑、或者跑完了事
        件还在重放窗口里，都抢不到——那时候调用方该做的是去读，不是再跑一遍。
        """
        ...

    async def renew(self, run_key: str, *, lease_seconds: float) -> None:
        """续期生产权，表示还在写。"""
        ...

    async def state(self, run_key: str) -> RunState:
        """这条流现在处于哪个阶段。"""
        ...

    async def exists(self, run_key: str) -> bool:
        """流里有帧吗（一帧都还没写，或者已经过了重放窗口，都是没有）。"""
        ...

    async def append(self, run_key: str, text: str, *, last: bool) -> RunFrame:
        """往流末尾写一帧，返回它的位置。"""
        ...

    async def read(self, run_key: str, *, after: str, block_ms: int | None) -> tuple[RunFrame, ...]:
        """读 ``after`` 之后的帧。

        ``block_ms`` 给正数就等这么久，等不到返回空；给 ``None`` 就立刻返回。
        """
        ...

    async def finish(self, run_key: str, *, keep_seconds: int) -> None:
        """收尾：把阶段落到 ``done``，并让流与这个标记一起在重放窗口后消失。"""
        ...


@dataclass(frozen=True, slots=True)
class RedisRunStream:
    """``RunStream`` 的 Redis Streams 实现。

    ``client`` 必须开着 ``decode_responses``，否则读回来的是 bytes。
    """

    client: Redis

    def _stream_key(self, run_key: str) -> str:
        return f"{_STREAM_PREFIX}{run_key}"

    def _state_key(self, run_key: str) -> str:
        return f"{_STREAM_PREFIX}{run_key}{_STATE_SUFFIX}"

    async def claim(self, run_key: str, *, lease_seconds: float) -> bool:
        # SET NX：键在就抢不到。跑完之后这个键会带着 done 一直留到重放窗口结
        # 束，所以窗口内不可能有第二个生产者。
        got = await self.client.set(self._state_key(run_key), _LIVE, nx=True, ex=int(lease_seconds))
        return bool(got)

    async def renew(self, run_key: str, *, lease_seconds: float) -> None:
        # 无条件覆盖，不判断标记还在不在：万一它已经过期、这条流被别人收了尾，
        # 重新写上也不会造成分歧——读的人认第一帧终帧，后面写的都被忽略。
        await self.client.set(self._state_key(run_key), _LIVE, ex=int(lease_seconds))

    async def state(self, run_key: str) -> RunState:
        marker = cast("str | None", await self.client.get(self._state_key(run_key)))
        if marker is None:
            return "gone"
        return "live" if marker == _LIVE else "done"

    async def exists(self, run_key: str) -> bool:
        return bool(await self.client.exists(self._stream_key(run_key)))

    async def append(self, run_key: str, text: str, *, last: bool) -> RunFrame:
        fields: dict[FieldT, EncodableT] = {_FRAME_FIELD: text}
        if last:
            # 「这是最后一帧」是流上的一个标记位，不是帧内容的一部分。读的人
            # 看这个标记就知道结束了，不用去解析帧本身。
            fields[_LAST_FIELD] = "1"
        cursor = await self.client.xadd(self._stream_key(run_key), fields)
        return RunFrame(cursor=str(cursor), text=text, last=last)

    async def read(self, run_key: str, *, after: str, block_ms: int | None) -> tuple[RunFrame, ...]:
        # redis-py 对 xread 的返回值只给了个宽泛类型，这里显式写清实际形状。
        got = cast(
            "list[tuple[str, list[tuple[str, dict[str, str]]]]] | None",
            await self.client.xread({self._stream_key(run_key): after}, block=block_ms),
        )
        if not got:
            return ()
        _, entries = got[0]
        return tuple(
            RunFrame(cursor=cursor, text=fields[_FRAME_FIELD], last=_LAST_FIELD in fields)
            for cursor, fields in entries
        )

    async def finish(self, run_key: str, *, keep_seconds: int) -> None:
        await self.client.expire(self._stream_key(run_key), keep_seconds)
        # 阶段标记跟流同寿命：窗口内它挡住第二个生产者，窗口过了两个一起消失，
        # 那时同一个运行 id 再来就是一次全新的运行。
        await self.client.set(self._state_key(run_key), _DONE, ex=keep_seconds)


__all__ = ["STREAM_START", "RedisRunStream", "RunFrame", "RunState", "RunStream"]
