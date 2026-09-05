"""统一构造订阅帧内容；连接层附加 session、序号和时间信封。"""

from __future__ import annotations

from iclip.harness.transcript.store import SubscribeView
from iclip.platform.transcript.wire import OpsPayload, ResetPayload


def subscribe_frames(
    view: SubscribeView, *, agent_id: str, since: int | None
) -> tuple[ResetPayload | OpsPayload, ...]:
    """按客户端水位生成订阅帧。

    首次订阅发送 items 为空的 reset，历史由 REST 分页获取；窗口内重连仅补发批次。
    批次不可补发或水位来自重启前时仅发送 reset，客户端无条件覆盖水位后重新获取历史。
    """

    if since is not None and view.complete:
        return tuple(
            OpsPayload(agent_id=agent_id, ops=batch.ops, seq=batch.seq) for batch in view.batches
        )
    return (ResetPayload(agent_id=agent_id, snapshot=view.snapshot, seq=view.watermark),)


__all__ = ["subscribe_frames"]
