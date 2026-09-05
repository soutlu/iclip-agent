"""限定工具素材 URL 来自当前命名空间的台账，并校验媒体类型。

此处验证来源和类型；SSRF 防护属于实际获取素材的出网边界。
"""

from __future__ import annotations

from pydantic_ai import ModelRetry

from iclip.harness.media import media_kind_label
from iclip.platform.material_ledger.store import MaterialKind, MaterialLedger


def require_http(url: str, *, what: str) -> None:
    """要求素材地址使用 HTTP(S)。"""

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
    """校验当前会话的素材与类型。

    错误不回显被拒 URL，避免未经认可的地址通过错误消息进入模型上下文。
    recorded_at 由调用方提供，说明能力使用的素材记录位置。
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
