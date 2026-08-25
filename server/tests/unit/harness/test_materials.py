"""素材范围：哪些地址算这段对话的，哪些不算。

这一层全是纯函数，不需要 agent 真跑起来——直接手搭消息列表，看 ``run_materials``
怎么判。要钉死的是**边界**：模型自己写的不算、错误消息回显的不算、工具产出的算但
没有种类。
"""

from __future__ import annotations

from pydantic_ai import Agent
from pydantic_ai.messages import (
    ImageUrl,
    ModelMessage,
    ModelRequest,
    ModelResponse,
    RetryPromptPart,
    SystemPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.tools import RunContext

from iclip.harness.materials import run_materials
from iclip.harness.media import media_tag, media_tag_close, media_tag_open

VIDEO = "https://cdn.test/ref.mp4"
IMAGE = "https://cdn.test/shot.jpg"
BOARD = "https://oss.test/shot-frames/k/board/1.jpg"


def user(*chunks: str) -> ModelRequest:
    return ModelRequest(parts=[UserPromptPart(content=list(chunks))])


def tool(content: object) -> ModelRequest:
    return ModelRequest(parts=[ToolReturnPart(tool_name="t", content=content, tool_call_id="1")])


# ── 用户带进来的素材 ──────────────────────────────────────────────────────────


def test_user_attachment_declares_kind() -> None:
    """用户发的附件是 tag，种类明写在上面。"""

    materials = run_materials([user(media_tag("video", VIDEO, name="ref.mp4"), "拆一下")])

    assert materials.appears(VIDEO)
    assert materials.kind_of(VIDEO) == "video"
    assert materials.declared("video") == (VIDEO,)
    assert materials.declared("image") == ()


def test_image_attachment_keeps_original_url_not_the_resized_one() -> None:
    """图片在上下文里是「tag + 像素」两段，身份地址取 tag 里那个原图。

    喂给厂商的那份带缩放参数，模型读不到它——所以像素 part 一律不收，收了等于把模
    型没看过的地址当成它抄得到的。
    """

    resized = f"{IMAGE}?x-oss-process=image/resize,l_1024"
    materials = run_materials(
        [
            ModelRequest(
                parts=[
                    UserPromptPart(
                        content=[
                            media_tag_open("image", IMAGE),
                            ImageUrl(url=resized),
                            media_tag_close("image"),
                        ]
                    )
                ]
            )
        ]
    )

    assert materials.kind_of(IMAGE) == "image"
    assert not materials.appears(resized)


def test_instructions_count_as_context() -> None:
    """指令是我们自己写的请求侧文本，在里面挂一个固定素材算数。"""

    materials = run_materials(
        [ModelRequest(parts=[], instructions=f"底图一律用 {media_tag('image', IMAGE)}")]
    )

    assert materials.kind_of(IMAGE) == "image"


def test_system_prompt_counts_as_context() -> None:
    materials = run_materials([ModelRequest(parts=[SystemPromptPart(content=f"参考 {VIDEO}")])])

    assert materials.appears(VIDEO)


# ── 工具产出的素材 ────────────────────────────────────────────────────────────


def test_structured_tool_return_gives_address_without_kind() -> None:
    """dict 返回会被整体序列化成 JSON：地址逐字还在，tag 却因转义扫不出来。

    这条不是缺陷是取舍——工具产出的地址本来就确凿来自本对话，用不着声明种类。钉
    死它免得将来有人把它当 bug 修。
    """

    materials = run_materials([tool({"boards": [{"board": 1, "url": BOARD}]})])

    assert materials.appears(BOARD)
    assert materials.kind_of(BOARD) is None


def test_tag_inside_structured_return_is_escaped_away() -> None:
    """同一轮里 ReadMediaFile 返回的 tag（list 形状）同样只剩地址，没有种类。"""

    materials = run_materials([tool([media_tag_open("image", IMAGE), media_tag_close("image")])])

    assert materials.appears(IMAGE)
    assert materials.kind_of(IMAGE) is None


def test_string_tool_return_keeps_tags_readable() -> None:
    """``read_file`` 返回纯字符串，原样进上下文——账本里的 tag 因此扫得出种类。"""

    materials = run_materials([tool(f"账本正文\n{media_tag('video', VIDEO)}\n")])

    assert materials.kind_of(VIDEO) == "video"


# ── 不算素材的那一侧 ──────────────────────────────────────────────────────────


def test_model_output_never_counts() -> None:
    """模型自己写的不算：算了的话它写一句话就等于自己给自己发通行证。"""

    materials = run_materials(
        [
            ModelResponse(
                parts=[
                    TextPart(content=media_tag("video", VIDEO)),
                    ToolCallPart(tool_name="t", args={"url": BOARD}, tool_call_id="1"),
                ]
            )
        ]
    )

    assert not materials.appears(VIDEO)
    assert not materials.appears(BOARD)
    assert materials.kind_of(VIDEO) is None


def test_retry_prompt_never_counts() -> None:
    """错误消息不算：回显一次被拒的地址，模型重试一次就把它洗成素材了。"""

    materials = run_materials(
        [ModelRequest(parts=[RetryPromptPart(content=f"{VIDEO} 不是这段对话里的素材")])]
    )

    assert not materials.appears(VIDEO)


def test_absent_address_is_not_a_material() -> None:
    materials = run_materials([user(media_tag("video", VIDEO))])

    assert not materials.appears("https://cdn.test/other.mp4")
    assert not materials.appears("")


async def test_a_running_tool_sees_the_conversation() -> None:
    """承重墙：真跑一次 agent 时，工具里的 ``ctx.messages`` 确实有用户那条消息。

    上面那些用例都手搭消息列表，验的是判定逻辑；这条验的是判定的**输入从哪来**。
    官方哪天不再把消息喂进 ``RunContext``，素材校验就会把一切都拒掉——那时该由这
    条用例先红，而不是等线上每件工具一起失灵。
    """

    seen: dict[str, object] = {}

    def call_probe_once(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        _ = info
        if len(messages) == 1:
            return ModelResponse(parts=[ToolCallPart(tool_name="probe", args={}, tool_call_id="1")])
        return ModelResponse(parts=[TextPart(content="done")])

    agent = Agent(FunctionModel(call_probe_once))

    @agent.tool
    def probe(ctx: RunContext[object]) -> str:
        materials = run_materials(ctx.messages)
        seen["appears"] = materials.appears(VIDEO)
        seen["kind"] = materials.kind_of(VIDEO)
        return "ok"

    await agent.run(f"{media_tag('video', VIDEO, name='ref.mp4')} 帮我拆一下")

    assert "appears" in seen, "工具压根没被调到，这条用例什么也没验到"
    assert seen == {"appears": True, "kind": "video"}


def test_prefix_of_a_real_address_passes() -> None:
    """已知取舍：判定是子串包含，所以合法地址的前缀也算出现过。

    截短了只能落在同一个域名下，够不到别处；换来的是不必解析各种形状的工具返回。
    """

    materials = run_materials([user(media_tag("video", VIDEO))])

    assert materials.appears("https://cdn.test/ref")
