"""本次运行的素材范围：模型能交给工具的地址，只有台账里记着的那些。

模型传给工具的地址只有两个来源——从上下文里抄来的，或者自己编的。工具收到的是同一
个字符串，分不出来。系统收下附件、或自己往公开桶落一个地址时，就在台账上记一条；
工具收到地址时按 ``(命名空间, url)`` 查一条，查得到才放行。

**这是来源约束，不是安全边界。** 它挡的是凭空捏造、跨对话串用、把视频当图片这三件
事。真要防 SSRF，得在出网取素材那一层单独做。
"""

from __future__ import annotations

from pydantic_ai import ModelRetry

from iclip.harness.media import media_kind_label
from iclip.platform.material_ledger.store import MaterialKind, MaterialLedger


def require_http(url: str, *, what: str) -> None:
    """要求这个地址是 HTTP 地址。收地址的工具在登记时挂上它。"""

    if not url.startswith(("http://", "https://")):
        raise ModelRetry(f"{what}必须是 http:// 或 https:// 开头；收到的是 {url!r}。")


async def require_material(
    ledger: MaterialLedger,
    namespace: str,
    url: str,
    *,
    kind: MaterialKind,
    what: str,
    recorded_at: str,
) -> None:
    """要求这个地址是本对话的素材，而且种类对得上。

    错误消息一律**不回显被拒的地址**。回显了，模型重试一次就把它洗成上下文里出现
    过的东西了——下一次同样的调用就会放行。``recorded_at`` 是调用方那句「本能力写下
    的地址记在哪」，因为那是各能力自己的账本。
    """

    recorded = await ledger.lookup(namespace, url)
    if recorded is None:
        raise ModelRetry(
            f"这个{what}不是这段对话里的素材。只能用对话里给你的地址、或工具结果里"
            f"返回的地址，不要自己拼；{recorded_at}"
        )
    if recorded.kind != kind:
        raise ModelRetry(
            f"这个地址在对话里是一份{media_kind_label(recorded.kind)}，当不了{what}。"
            f"换一个{media_kind_label(kind)}的地址。"
        )


__all__ = ["require_http", "require_material"]
