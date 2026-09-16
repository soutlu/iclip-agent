"""本地 HTTP 媒体服务，供远程切片测试用。

ffmpeg 自己走 http 去拿素材，不经 httpx transport，所以喂它假响应的办法只有起一个真服务。
``ranges=False`` 用来模拟忽略 Range 的源：整份返回 200。
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import dataclass

_RANGE = re.compile(r"^bytes=(\d+)-(\d*)$")


_CHUNK = 64 * 1024


@dataclass(frozen=True, slots=True)
class Delivery:
    """一次请求送出去多少：``wanted`` 是 Range 头，``sent`` 是客户端真收下的字节数。"""

    target: str
    wanted: str | None
    sent: int


@dataclass(frozen=True, slots=True)
class MediaServer:
    """一个只读的取素材端点。``deliveries`` 按顺序记下每次请求。"""

    base_url: str
    deliveries: list[Delivery]

    def url(self, name: str) -> str:
        return f"{self.base_url}/{name}"

    @property
    def sent(self) -> int:
        """一共送出去多少字节；按需读只有索引加选区，整片顺序读是全量。"""

        return sum(item.sent for item in self.deliveries)

    @property
    def range_requests(self) -> int:
        """带 Range 头的请求数。"""

        return sum(1 for item in self.deliveries if item.wanted is not None)


async def _respond(
    writer: asyncio.StreamWriter, status: int, body: bytes, headers: dict[str, str]
) -> int:
    """回一份响应，返回客户端真收下的字节数——它读够了就断开，不必送完。"""

    # ffmpeg 默认每次 seek 另起一条连接，所以固定 Connection: close，不做 keep-alive。
    head = "\r\n".join(
        [
            f"HTTP/1.1 {status} x",
            "Content-Type: video/mp4",
            f"Content-Length: {len(body)}",
            *(f"{name}: {value}" for name, value in headers.items()),
            "Connection: close",
            "",
            "",
        ]
    )
    writer.write(head.encode("latin-1"))
    sent = 0
    try:
        for at in range(0, len(body), _CHUNK):
            chunk = body[at : at + _CHUNK]
            writer.write(chunk)
            await writer.drain()
            sent += len(chunk)
        writer.close()
    except (ConnectionError, BrokenPipeError):
        pass
    return sent


def _parse(request: bytes) -> tuple[str, str | None]:
    """取请求目标与 Range 头。"""

    lines = request.decode("latin-1").split("\r\n")
    parts = lines[0].split(" ")
    target = parts[1].lstrip("/") if len(parts) > 1 else ""
    for line in lines[1:]:
        name, _, value = line.partition(":")
        if name.strip().lower() == "range":
            return target, value.strip()
    return target, None


@asynccontextmanager
async def serving(files: dict[str, bytes], *, ranges: bool = True) -> AsyncGenerator[MediaServer]:
    """在随机端口上提供这些文件，退出上下文时关停。

    ``files`` 的键是路径名（``base.mp4``），值是整份字节。支持 ``bytes=a-b`` 形式的单段
    Range；``ranges=False`` 时一律整份返回 200。"""

    seen: list[Delivery] = []

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            target, wanted = _parse(await reader.readuntil(b"\r\n\r\n"))
        except (asyncio.IncompleteReadError, ConnectionError):  # pragma: no cover - 半开连接
            writer.close()
            return
        sent = await _serve(writer, target, wanted)
        seen.append(Delivery(target=target, wanted=wanted, sent=sent))

    async def _serve(writer: asyncio.StreamWriter, target: str, wanted: str | None) -> int:
        body = files.get(target)
        if body is None:
            return await _respond(writer, 404, b"", {})
        requested = _RANGE.match(wanted or "") if ranges else None
        if requested is None:
            return await _respond(
                writer, 200, body, {"Accept-Ranges": "bytes" if ranges else "none"}
            )
        start = int(requested.group(1))
        end = min(int(requested.group(2) or len(body) - 1), len(body) - 1)
        return await _respond(
            writer,
            206,
            body[start : end + 1],
            {"Accept-Ranges": "bytes", "Content-Range": f"bytes {start}-{end}/{len(body)}"},
        )

    started = await asyncio.start_server(handle, host="127.0.0.1", port=0)
    async with started:
        port = started.sockets[0].getsockname()[1]
        yield MediaServer(base_url=f"http://127.0.0.1:{port}", deliveries=seen)


__all__ = ["Delivery", "MediaServer", "serving"]
