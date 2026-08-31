"""订阅时该发哪些帧。

这一条判断单独放在这里，不留给 WS 那一层自己拼：判错了服务端一切正常，客户端却会安静地停止
更新——它是本仓「违反了会静默」的三条之一。
"""

from __future__ import annotations

from iclip.harness.transcript.store import SubscribeView
from iclip.platform.transcript.wire import TranscriptOps, TranscriptReset


def subscribe_frames(
    view: SubscribeView, *, agent_id: str, since: int | None
) -> tuple[TranscriptReset | TranscriptOps, ...]:
    """按客户端手上的水位，给出这一刻该发出去的帧。

    三种情形：

    - **第一次订阅**（``since`` 是 ``None``）：只发一帧 reset。它的 ``snapshot.items`` 按协议
      恒空，历史随后由客户端走 REST 分页取。
    - **接得上**（要的批次都还在补批窗口里）：只发那些批次，不发 reset。这时发 reset 会把客户端
      已经有的那份全局实体整个换掉，白白逼它重拉一遍。
    - **接不上**（批次已经出了窗口，或者水位来自上一代编号——进程重启后号从 1 重来）：发一帧
      reset，不补批。客户端收到会把本地水位**无条件覆写**成帧里的 ``seq``（不是取较大值），
      于是它跟着退回当前这一代，再走 REST 把内容拉齐。

    漏掉最后这一种的话，客户端会守着一个比服务端还大的水位，之后每一批都被它当成旧的丢掉。
    """

    if since is not None and view.complete:
        return tuple(
            TranscriptOps(agent_id=agent_id, ops=batch.ops, seq=batch.seq) for batch in view.batches
        )
    return (TranscriptReset(agent_id=agent_id, snapshot=view.snapshot, seq=view.watermark),)


__all__ = ["subscribe_frames"]
