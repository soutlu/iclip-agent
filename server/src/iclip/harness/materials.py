"""本次运行的素材范围：模型能交给工具的地址，只有这段对话里出现过的那些。

模型传给工具的地址只有两个来源——从上下文里抄来的，或者自己编的。工具收到的是同
一个字符串，分不出来。本模块把上下文摊成一段文本，让「抄的还是编的」变成一个当场
能回答的问题：不查库，也不另立登记表，因为消息列表本身就是那张表。

**只认模型请求那一侧。** 消息列表里是两拨人写的：请求侧是外面放进来的（用户消息、
工具结果、我们自己的指令），响应侧是模型自己写的（正文、工具调用参数）。响应侧一律
不算——算了的话，模型在正文里写一个地址就等于自己给自己发通行证。厂商内建工具的返
回（联网搜索那类）也在响应侧，一并挡住：那是外部网页内容，让它指挥我们的服务器去
取素材，比模型自己编还危险。

**种类只有 tag 声明得了。** 用户发的附件经 ``media`` 换成 ``<video url="…">``，种类
明写在标签上。工具产出的地址是 JSON 字段里的裸串，没人声明种类——它们照样是素材
（确凿是本对话里产出的），只是要种类的工具认不了它们。

**这是来源约束，不是安全边界。** 工作区是模型可写的，写个地址进去再 ``read_file``
读回来就绕过去了；用户自己在对话里打一个内网地址也直接算数。它挡的是凭空捏造、跨
对话串用、把视频当图片这三件事。真要防 SSRF，得在出网取素材那一层单独做。
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass

from pydantic_ai import ModelRetry
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelRequestPart,
    SystemPromptPart,
    TextContent,
    ToolReturnPart,
    UserPromptPart,
)

from iclip.harness.media import MediaKind, iter_media_tags, media_kind_label


@dataclass(frozen=True, slots=True)
class RunMaterials:
    """这次运行摸得着的素材。"""

    kinds: Mapping[str, MediaKind]
    """被 tag 声明过种类的地址。"""

    _text: str
    """请求侧的全部文本，连成一段。一个地址算不算素材，靠它逐字回答。"""

    def appears(self, url: str) -> bool:
        """这个地址在上下文里逐字出现过吗。

        做子串包含而不是把地址正则抽出来：工具结果是什么形状随它去（dict 会被序
        列化成 JSON、字符串原样留着），地址总归逐字写在里面。代价是合法地址的前
        缀也算出现过（``…/ref.mp4`` 在场时 ``…/ref`` 能过）——同一个域名下、够不
        到别处，接受这个取舍。
        """

        return bool(url) and url in self._text

    def kind_of(self, url: str) -> MediaKind | None:
        """这个地址被声明成了什么；没有 tag 声明过就是 ``None``。"""

        return self.kinds.get(url)

    def declared(self, kind: MediaKind) -> tuple[str, ...]:
        """声明为某个种类的全部地址，用来告诉模型「有哪些可选」。"""

        return tuple(url for url, declared in self.kinds.items() if declared == kind)


def run_materials(messages: Sequence[ModelMessage]) -> RunMaterials:
    """从这次运行的消息里算出素材范围。"""

    chunks: list[str] = []
    for message in messages:
        if not isinstance(message, ModelRequest):
            continue
        if message.instructions:
            chunks.append(message.instructions)
        for part in message.parts:
            chunks.extend(_part_text(part))
    text = "\n".join(chunks)
    return RunMaterials(kinds={tag.url: tag.kind for tag in iter_media_tags(text)}, _text=text)


def _part_text(part: ModelRequestPart) -> Iterator[str]:
    """一个请求侧 part 里，模型读得到的文本。

    ``RetryPromptPart`` 不收：错误消息里但凡回显了被拒的地址，模型重试一次就把它
    洗成素材了。多模态项也不收——那份像素的地址只进厂商的请求体，模型读不到它，收
    了等于把它没看过的地址当成它抄得到的。
    """

    if isinstance(part, SystemPromptPart):
        yield part.content
    elif isinstance(part, UserPromptPart):
        content = part.content
        if isinstance(content, str):
            yield content
            return
        for item in content:
            if isinstance(item, str):
                yield item
            elif isinstance(item, TextContent):
                yield item.content
    elif isinstance(part, ToolReturnPart):
        # 非字符串的工具返回会被整体序列化成 JSON，里面的 tag 因此带上转义引号、
        # 扫不出种类来（地址本身仍逐字在，照样算素材）。所以工具产出的地址只在同
        # 一轮里当「没声明种类」的那一档用；`read_file` 返回纯字符串，不受此影响。
        yield part.model_response_str()


def require_http(url: str, *, what: str) -> None:
    """要求这个地址是 HTTP 地址。收地址的工具在登记时挂上它。"""

    if not url.startswith(("http://", "https://")):
        raise ModelRetry(f"{what}必须是 http:// 或 https:// 开头；收到的是 {url!r}。")


def require_recorded(materials: RunMaterials, url: str, *, what: str, recorded_at: str) -> None:
    """要求这个地址在本对话里出现过，不问种类。

    工具自己产出的地址是 JSON 字段里的裸串，没人给它们声明过种类（见模块开头）。收这类
    地址的工具只问得了「是不是本对话产出的」，问种类等于把自己的产物拒在门外。

    同 ``require_material``，错误消息不回显被拒的地址：回显了，模型重试一次就把它洗成
    上下文里出现过的东西了。
    """

    if not materials.appears(url):
        raise ModelRetry(
            f"这个{what}不是这段对话里的素材。只能用对话里给你的地址、或工具结果里"
            f"返回的地址，不要自己拼；{recorded_at}"
        )


def require_material(
    materials: RunMaterials, url: str, *, kind: MediaKind, what: str, recorded_at: str
) -> None:
    """要求这个地址是本对话的素材：出现过；被声明过种类的，种类还得对得上。

    种类只在「声明过」时查：那个信息只有用户发的附件带得来（tag 写在上面），工具自己
    产出的地址是裸的，对它们查种类等于把自己的产物拒在门外。

    错误消息一律**不回显被拒的地址**。回显了，模型重试一次就把它洗成上下文里出现
    过的东西了——下一次同样的调用就会放行。``recorded_at`` 是调用方那句「本能力写下
    的地址记在哪」，因为那是各能力自己的账本。
    """

    if not materials.appears(url):
        known = materials.declared(kind)
        if known:
            raise ModelRetry(
                f"这个{what}不是这段对话里的素材。本对话的{media_kind_label(kind)}有："
                f"{'、'.join(known)}。逐字抄其中一个。"
            )
        raise ModelRetry(
            f"这个{what}不是这段对话里的素材。只能用对话里给你的地址、或工具结果里"
            f"返回的地址，不要自己拼；{recorded_at}"
        )
    declared = materials.kind_of(url)
    if declared is not None and declared != kind:
        raise ModelRetry(
            f"这个地址在对话里是一份{media_kind_label(declared)}，当不了{what}。"
            f"换一个{media_kind_label(kind)}的地址。"
        )


__all__ = [
    "RunMaterials",
    "require_http",
    "require_material",
    "require_recorded",
    "run_materials",
]
