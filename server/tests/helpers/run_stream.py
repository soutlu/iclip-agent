"""内存版事件流：只有最小状态机，没有生产逻辑。

给不需要真 Redis 的层用（HTTP 契约、错误映射）。位置用「第几帧」的序号，读的
人只是把它原样报回来，不解析。

**语义必须和 Redis 那版一致**，尤其是 ``claim`` 与 ``state``：这两处如果宽松
一点，替身上绿的测试到真 Redis 上就是错的。
"""

from __future__ import annotations

import asyncio

from iclip.harness.run_stream_redis import STREAM_START, RunFrame, RunState


class MemoryRunStream:
    """``RunStream`` 的内存实现。"""

    def __init__(self) -> None:
        self.frames: dict[str, list[RunFrame]] = {}
        self.states: dict[str, RunState] = {}

    async def claim(self, run_key: str, *, lease_seconds: float) -> bool:
        if self.states.get(run_key, "gone") != "gone":
            return False
        self.states[run_key] = "live"
        return True

    async def renew(self, run_key: str, *, lease_seconds: float) -> None:
        self.states[run_key] = "live"

    async def state(self, run_key: str) -> RunState:
        return self.states.get(run_key, "gone")

    async def exists(self, run_key: str) -> bool:
        return run_key in self.frames

    async def append(self, run_key: str, text: str, *, last: bool) -> RunFrame:
        entries = self.frames.setdefault(run_key, [])
        frame = RunFrame(cursor=f"{len(entries) + 1}-0", text=text, last=last)
        entries.append(frame)
        return frame

    async def read(self, run_key: str, *, after: str, block_ms: int | None) -> tuple[RunFrame, ...]:
        entries = self.frames.get(run_key, [])
        start = 0 if after == STREAM_START else int(after.split("-")[0])
        fresh = tuple(entries[start:])
        if not fresh and block_ms is not None:
            # 真 Redis 会在这儿阻塞等新帧。内存版没得等，让出一次控制权，好让
            # 同一个事件循环里的生产者往下走——否则读的人会空转。
            await asyncio.sleep(0.005)
        return fresh

    async def finish(self, run_key: str, *, keep_seconds: int) -> None:
        self.states[run_key] = "done"
