"""工作区能力：路径语法边界、七件工具的行为与错误翻译、命名空间隔离。

存储与图片探针用进程内替身（存储走和 PG 实现同一条判定序列），所以这一层测的是
「能力和工具面的语义」，不是 SQL、也不是 OSS。真库那一侧另有集成验收。
"""

from __future__ import annotations

import inspect
import uuid

import pytest
from pydantic_ai import Agent, ModelRetry
from pydantic_ai.messages import (
    ImageUrl,
    ModelMessage,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturn,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import RunContext
from pydantic_ai.usage import RunUsage
from pydantic_ai_harness.subagents import SubAgent, SubAgents

from iclip.capabilities.workspace.capability import (
    CAPABILITY_ID,
    FULL_RESOLUTION_MAX_BYTES,
    CropRegion,
    Workspace,
    WorkspaceToolset,
    workspace_capability,
)
from iclip.capabilities.workspace.ports import ImageInfo, MediaProbeFailed
from iclip.capabilities.workspace.scope import workspace_namespace
from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.identity.models import Principal
from iclip.platform.file_store.store import (
    FileSpace,
    InvalidPath,
    QuotaExceeded,
    StoredFile,
    VersionConflict,
    normalize_path,
)
from iclip.platform.material_ledger.store import Material
from iclip.platform.transcript.display import (
    FileIoDisplay,
    GenericDisplay,
    SearchDisplay,
    ToolDisplayRegistry,
    UrlFetchDisplay,
)
from tests.helpers.file_store import FakeFileStore
from tests.helpers.material_ledger import FakeMaterialLedger

USER = uuid.UUID("11111111-1111-1111-1111-111111111111")
OTHER_USER = uuid.UUID("22222222-2222-2222-2222-222222222222")
THREAD = "thread-1"
OTHER_THREAD = "thread-2"
NS = f"{USER}/{THREAD}"

OSS_IMAGE = "https://bucket.oss-cn-hangzhou.aliyuncs.com/style.jpg"


A_BIG_JPEG = ImageInfo(media_type="image/jpeg", size_bytes=2048, width=3000, height=2000)


class FakeProbe:
    """固定回一份原图信息，或者一口拒绝。"""

    def __init__(self, info: ImageInfo = A_BIG_JPEG, *, error: str | None = None) -> None:
        self.info = info
        self.error = error

    async def image_info(self, url: str) -> ImageInfo:
        _ = url
        if self.error is not None:
            raise MediaProbeFailed(self.error)
        return self.info


def make_principal(user_id: uuid.UUID = USER) -> Principal:
    return Principal(
        kind="user",
        user_id=user_id,
        permissions=frozenset({"agent:run"}),
        audit_label="luke",
        api_key_id=None,
    )


def make_deps(user_id: uuid.UUID = USER, conversation_id: str = THREAD) -> AgentRunDeps:
    return AgentRunDeps(principal=make_principal(user_id), conversation_id=conversation_id)


def make_context(deps: object) -> RunContext[object]:
    """造一次运行的上下文。"""

    return RunContext[object](deps=deps, model=TestModel(), usage=RunUsage(), messages=[])


def image_ledger(*urls: str) -> FakeMaterialLedger:
    """一份记着这几个图片地址的台账，当作收件那一步已经记过了。"""

    fake = FakeMaterialLedger()
    for url in urls:
        fake.rows[(NS, url)] = Material(url=url, kind="image")
    return fake


def make_workspace(
    store: FakeFileStore,
    probe: FakeProbe | None = None,
    ledger: FakeMaterialLedger | None = None,
) -> Workspace[object]:
    return workspace_capability(
        space=FileSpace(store=store, namespace=workspace_namespace),
        probe=probe if probe is not None else FakeProbe(),
        ledger=ledger if ledger is not None else FakeMaterialLedger(),
    )


def model_facing(result: ToolReturn) -> list[object]:
    """工具返回里给模型那几段。

    ``return_value`` 的类型是官方那个内容联合，不随泛型参数收窄，所以读它得先 isinstance。
    """

    value = result.return_value
    assert isinstance(value, list)
    return list(value)


@pytest.fixture
def store() -> FakeFileStore:
    return FakeFileStore()


@pytest.fixture
def capability(store: FakeFileStore) -> Workspace[object]:
    return make_workspace(store)


@pytest.fixture
def tools(capability: Workspace[object]) -> WorkspaceToolset[object]:
    return WorkspaceToolset(capability)


@pytest.fixture
def ctx() -> RunContext[object]:
    return make_context(make_deps())


# --------------------------------------------------------------------------
# 路径语法：边界就是这套字符串规则本身
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    [
        "../etc/passwd",
        "分镜/../../secrets.md",
        "a/./b.md",
        "..",
        "notes\\a.md",
        "notes/",
        "",
        "/",
        "a\x00b.md",
        "/".join("x" * 2 for _ in range(20)),
        "x" * 200 + ".md",
    ],
)
def test_illegal_paths_are_refused(path: str) -> None:
    """越界靠语法拦，不靠 resolve——这里根本没有 inode 可以 resolve。"""

    with pytest.raises(InvalidPath):
        normalize_path(path)


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        ("/分镜/第一集.md", "分镜/第一集.md"),
        ("分镜//第一集.md", "分镜/第一集.md"),
        ("笔记.md", "笔记.md"),
    ],
)
def test_paths_are_canonicalized(given: str, expected: str) -> None:
    assert normalize_path(given) == expected


def test_unicode_paths_normalize_to_one_file() -> None:
    """同一个名字的两种 Unicode 写法必须是同一个文件，不能变成两个。

    带音符的字母有两种合法码位写法：预组合的单个码位，和基字母加组合符号。
    不归一化的话，模型第二次写同一个文件名会新建出第二个文件来。
    """

    assert normalize_path("caf\u00e9.md") == normalize_path("cafe\u0301.md")


# --------------------------------------------------------------------------
# 命名空间：算不出来就失败，绝不退回公共空间
# --------------------------------------------------------------------------


def test_namespace_is_the_conversation_under_the_trusted_user() -> None:
    """对话 id 是客户端给的，只能当次级段；外层必须是可信的用户 id。"""

    assert workspace_namespace(make_context(make_deps())) == f"{USER}/{THREAD}"


def test_namespace_fails_closed_when_deps_is_not_a_run_deps() -> None:
    """运行身份没注进来是装配 bug；退回一个公共命名空间等于把所有人并成一个。"""

    with pytest.raises(RuntimeError, match="不是 AgentRunDeps"):
        workspace_namespace(make_context({"user_id": str(USER)}))


def test_a_forged_conversation_id_cannot_escape_its_user() -> None:
    """伪造 threadId 最多只能碰到自己的另一段对话，跨不到别人名下。"""

    assert workspace_namespace(make_context(make_deps())).startswith(f"{USER}/")


def test_scope_goes_through_normalization() -> None:
    """本能力取地盘必须经 ``FileSpace.resolve()``，不能拿规则算出来的原样值。

    绕开它不会报错，只会让另一件收同一个 ``FileSpace`` 的能力算出**另一个**字符
    串——两边各写各的地方，而且写读都成功。
    """

    dirty = FileSpace(store=FakeFileStore(), namespace=lambda _ctx: f"{USER}//{THREAD}")
    capability = workspace_capability(space=dirty, probe=FakeProbe(), ledger=FakeMaterialLedger())
    assert capability.resolve_scope(make_context(make_deps())) == NS


async def test_for_run_resolves_scope_before_any_tool_is_touched(
    capability: Workspace[object],
) -> None:
    """身份不对时这次运行就该失败，而不是等模型碰巧调了工作区工具才暴露。"""

    with pytest.raises(RuntimeError, match="不是 AgentRunDeps"):
        await capability.for_run(make_context("这不是运行依赖"))


async def test_two_users_do_not_see_each_other(
    tools: WorkspaceToolset[object], store: FakeFileStore
) -> None:
    mine = make_context(make_deps())
    theirs = make_context(make_deps(OTHER_USER))
    await tools.write_file(mine, "笔记.md", "我的稿子")
    assert "笔记.md" in await tools.list_files(mine)
    assert await tools.list_files(theirs) == "工作区还没有任何文件。"
    assert await store.read(f"{OTHER_USER}/{THREAD}", "笔记.md") is None


async def test_two_conversations_of_one_user_do_not_see_each_other(
    tools: WorkspaceToolset[object],
) -> None:
    """一段对话一个工作区：换一段对话就是一张干净的工作台。"""

    here = make_context(make_deps())
    there = make_context(make_deps(conversation_id=OTHER_THREAD))
    await tools.write_file(here, "笔记.md", "这段对话的稿子")
    assert await tools.list_files(there) == "工作区还没有任何文件。"


# --------------------------------------------------------------------------
# 文件那六件
# --------------------------------------------------------------------------


async def test_write_then_read_round_trip(
    tools: WorkspaceToolset[object], ctx: RunContext[object]
) -> None:
    assert "已写入 分镜/第一集.md" in await tools.write_file(
        ctx, "分镜/第一集.md", "镜头一\n镜头二"
    )
    assert await tools.read_file(ctx, "分镜/第一集.md") == "     1\t镜头一\n     2\t镜头二"


async def test_read_missing_file_is_retryable(
    tools: WorkspaceToolset[object], ctx: RunContext[object]
) -> None:
    with pytest.raises(ModelRetry, match="用 list_files"):
        await tools.read_file(ctx, "不存在.md")


async def test_read_pages_and_says_how_much_is_left(
    tools: WorkspaceToolset[object], ctx: RunContext[object]
) -> None:
    await tools.write_file(ctx, "长稿.md", "\n".join(f"第{n}行" for n in range(1, 11)))
    page = await tools.read_file(ctx, "长稿.md", offset=3, limit=2)
    assert "     3\t第3行" in page
    assert "     4\t第4行" in page
    # 少给了内容就必须说出来，不能让模型以为自己读完了。
    assert "还有 6 行没读" in page


async def test_read_past_the_end_is_retryable(
    tools: WorkspaceToolset[object], ctx: RunContext[object]
) -> None:
    await tools.write_file(ctx, "短稿.md", "只有一行")
    with pytest.raises(ModelRetry, match="只有 1 行"):
        await tools.read_file(ctx, "短稿.md", offset=99)


async def test_edit_replaces_a_unique_match(
    tools: WorkspaceToolset[object], ctx: RunContext[object]
) -> None:
    await tools.write_file(ctx, "稿.md", "开场是夜景\n结尾是日景")
    await tools.edit_file(ctx, "稿.md", "夜景", "黄昏")
    assert "开场是黄昏" in await tools.read_file(ctx, "稿.md")


async def test_edit_refuses_an_ambiguous_match(
    tools: WorkspaceToolset[object], ctx: RunContext[object]
) -> None:
    """出现多次就报错，绝不挑一个改——静默改错地方比报错难查得多。"""

    await tools.write_file(ctx, "稿.md", "夜景\n夜景")
    with pytest.raises(ModelRetry, match="出现了 2 次"):
        await tools.edit_file(ctx, "稿.md", "夜景", "黄昏")


async def test_edit_reports_a_miss_instead_of_guessing(
    tools: WorkspaceToolset[object], ctx: RunContext[object]
) -> None:
    await tools.write_file(ctx, "稿.md", "夜景")
    with pytest.raises(ModelRetry, match="找不到这段原文"):
        await tools.edit_file(ctx, "稿.md", "雨景", "黄昏")


async def test_edit_on_a_missing_file_points_at_write_file(
    tools: WorkspaceToolset[object], ctx: RunContext[object]
) -> None:
    with pytest.raises(ModelRetry, match="要新建就用 write_file"):
        await tools.edit_file(ctx, "不存在.md", "夜景", "黄昏")


async def test_edit_surfaces_a_concurrent_change_instead_of_clobbering_it(
    store: FakeFileStore, ctx: RunContext[object]
) -> None:
    """``edit_file`` 是读—改—写；中间被人插一刀就得失败，不能把别人的改动盖掉。"""

    class RacingStore(FakeFileStore):
        async def read(self, namespace: str, path: str) -> StoredFile | None:
            found = await super().read(namespace, path)
            # 模拟「读完之后、写回之前，另一个运行落地了一次写入」。
            await super().write(namespace, path, "别人写的内容")
            return found

    racing = RacingStore()
    await racing.write(NS, "稿.md", "夜景")
    tools = WorkspaceToolset(make_workspace(racing))
    with pytest.raises(ModelRetry, match="重新读一遍"):
        await tools.edit_file(ctx, "稿.md", "夜景", "黄昏")


async def test_delete_removes_the_file_and_reports_a_miss(
    tools: WorkspaceToolset[object], ctx: RunContext[object]
) -> None:
    await tools.write_file(ctx, "废稿.md", "不要了")
    assert await tools.delete_file(ctx, "废稿.md") == "已删除 废稿.md"
    with pytest.raises(ModelRetry, match="无从删除"):
        await tools.delete_file(ctx, "废稿.md")


async def test_list_scopes_by_segment_boundary(
    tools: WorkspaceToolset[object], ctx: RunContext[object]
) -> None:
    """给的是「分镜」就只该看到分镜目录下的，不能把「分镜稿.md」也算进去。"""

    await tools.write_file(ctx, "分镜/第一集.md", "a")
    await tools.write_file(ctx, "分镜稿.md", "b")
    listed = await tools.list_files(ctx, prefix="分镜")
    assert "分镜/第一集.md" in listed
    assert "分镜稿.md" not in listed


async def test_search_reports_the_matching_lines(
    tools: WorkspaceToolset[object], ctx: RunContext[object]
) -> None:
    await tools.write_file(ctx, "稿.md", "开场是夜景\n中段是雨\n结尾也是夜景")
    found = await tools.search_files(ctx, "夜景")
    assert "稿.md:1" in found
    assert "稿.md:3" in found
    assert "稿.md:2" not in found


async def test_search_is_case_insensitive_and_literal(
    tools: WorkspaceToolset[object], ctx: RunContext[object]
) -> None:
    await tools.write_file(ctx, "稿.md", "SCENE 100%\n别的行")
    assert "稿.md:1" in await tools.search_files(ctx, "scene")
    # % 是字面量而不是通配符，否则检索会命中一切。
    assert "没有包含" in await tools.search_files(ctx, "%别的")


async def test_search_without_hits_says_so(
    tools: WorkspaceToolset[object], ctx: RunContext[object]
) -> None:
    await tools.write_file(ctx, "稿.md", "夜景")
    assert "没有包含" in await tools.search_files(ctx, "雨景")


async def test_search_flags_that_it_held_matches_back(
    tools: WorkspaceToolset[object], ctx: RunContext[object]
) -> None:
    await tools.write_file(ctx, "a.md", "夜景")
    await tools.write_file(ctx, "b.md", "夜景")
    found = await tools.search_files(ctx, "夜景", limit=1)
    assert "只报了一部分" in found


# --------------------------------------------------------------------------
# 容量上限
# --------------------------------------------------------------------------


async def test_oversized_file_is_refused_with_the_file_limit(ctx: RunContext[object]) -> None:
    tools = WorkspaceToolset(make_workspace(FakeFileStore(max_file_bytes=100)))
    with pytest.raises(ModelRetry, match="超过单文件上限"):
        await tools.write_file(ctx, "稿.md", "x" * 101)


async def test_full_workspace_tells_the_model_how_to_recover(ctx: RunContext[object]) -> None:
    """撞上总量上限必须给出自救手段，否则模型就卡死在这儿了。"""

    tools = WorkspaceToolset(make_workspace(FakeFileStore(max_namespace_bytes=100)))
    await tools.write_file(ctx, "a.md", "x" * 80)
    with pytest.raises(ModelRetry, match="删掉"):
        await tools.write_file(ctx, "b.md", "y" * 80)
    # 覆盖同一个文件只算差量，不该被自己的旧内容挡住。
    assert "已写入 a.md" in await tools.write_file(ctx, "a.md", "z" * 90)


async def test_quota_and_conflict_are_distinguishable(store: FakeFileStore) -> None:
    """两种失败给模型的提示完全相反，所以存储层必须报成两种错。"""

    small = FakeFileStore(max_namespace_bytes=10)
    with pytest.raises(QuotaExceeded):
        await small.write(NS, "a.md", "x" * 20)
    await store.write(NS, "a.md", "x")
    with pytest.raises(VersionConflict):
        await store.write(NS, "a.md", "y", expected_version=99)


# --------------------------------------------------------------------------
# 读图
# --------------------------------------------------------------------------


def read_tools(
    probe: FakeProbe, ledger: FakeMaterialLedger | None = None
) -> WorkspaceToolset[object]:
    return WorkspaceToolset(make_workspace(FakeFileStore(), probe, ledger))


async def check_args(
    tools: WorkspaceToolset[object], ctx: RunContext[object], **args: object
) -> None:
    """走一遍读图登记时挂上的验证器（官方在 schema 校验之后、执行之前调它）。

    从登记表上取，不直接调那个函数：漏传 ``args_validator=`` 时这条用例也要红。
    """

    validator = tools.tools["ReadMediaFile"].args_validator
    assert validator is not None, "ReadMediaFile 登记时没挂验证器"
    outcome = validator(ctx, **args)
    assert inspect.isawaitable(outcome), "本包的验证器都是 async 的"
    await outcome


async def test_a_big_image_is_downsampled_and_says_so() -> None:
    """默认交付缩略档：4K 原图整个进上下文没有多少信号，账单却会涨。

    摘要里必须写清原图多大、这次给的是降采样档，否则模型会拿缩略档的像素当原图坐标。
    """

    result = await read_tools(FakeProbe()).read_media_file(make_context(make_deps()), OSS_IMAGE)

    assert model_facing(result) == [
        f'<image url="{OSS_IMAGE}">',
        "原图 3000×2000 像素，image/jpeg，2.0 KB；已降采样到长边 1024。"
        "要看清小字或细节，用 `region` 按原图像素坐标看一块。输出坐标一律按原图尺寸算。",
        ImageUrl(url=f"{OSS_IMAGE}?x-oss-process=image/resize,l_1024", media_type="image/jpeg"),
        "</image>",
    ]
    # 给人看的那份指向真正交付的那个地址，不是 tag 里的原图。
    assert result.metadata == {
        "items": [
            {
                "url": f"{OSS_IMAGE}?x-oss-process=image/resize,l_1024",
                "caption": "已降采样到长边 1024",
            }
        ]
    }


async def test_a_small_image_goes_untouched() -> None:
    """长边本来就不超过 1024 的图原样附上：OSS 不放大，挂个缩放参数只是白挂。"""

    probe = FakeProbe(ImageInfo(media_type="image/png", size_bytes=1536, width=800, height=600))
    result = await read_tools(probe).read_media_file(make_context(make_deps()), OSS_IMAGE)

    assert model_facing(result) == [
        f'<image url="{OSS_IMAGE}">',
        "原图 800×600 像素，image/png，1.5 KB；未缩放。",
        ImageUrl(url=OSS_IMAGE, media_type="image/png"),
        "</image>",
    ]


async def test_a_region_crops_in_original_coordinates_and_flags_the_offset() -> None:
    """裁切按原图像素坐标走，裁出来还超 1024 就再级联一道缩放（OSS 按 ``/`` 顺序执行）。

    区域尺寸报的是收窄后的那个：给的 width/height 越过右下边界时 OSS 裁到边界为止，照
    原样报会让模型以为自己看到了不存在的那几百像素。
    """

    result = await read_tools(FakeProbe()).read_media_file(
        make_context(make_deps()),
        OSS_IMAGE,
        region=CropRegion(x=100, y=100, width=5000, height=5000),
    )

    delivered = f"{OSS_IMAGE}?x-oss-process=image/crop,x_100,y_100,w_5000,h_5000/resize,l_1024"
    assert model_facing(result) == [
        f'<image url="{OSS_IMAGE}">',
        "原图 3000×2000 像素，image/jpeg，2.0 KB；当前显示区域 x=100, y=100, 2900×1900，"
        "已降采样到长边 1024。输出原图坐标时加上区域偏移 (x, y)。",
        ImageUrl(url=delivered, media_type="image/jpeg"),
        "</image>",
    ]


async def test_a_small_region_is_not_downsampled_again() -> None:
    """裁出来已经在 1024 以内就不再挂缩放：那道参数什么也不做，摘要却会多说一句假话。"""

    result = await read_tools(FakeProbe()).read_media_file(
        make_context(make_deps()), OSS_IMAGE, region=CropRegion(x=10, y=20, width=200, height=100)
    )

    assert model_facing(result)[2] == ImageUrl(
        url=f"{OSS_IMAGE}?x-oss-process=image/crop,x_10,y_20,w_200,h_100",
        media_type="image/jpeg",
    )
    assert "已降采样" not in str(model_facing(result)[1])


async def test_a_region_starting_outside_the_image_reports_the_real_size() -> None:
    """起点在图外时 OSS 会回一张空图；报出原图尺寸，模型才有得重算。"""

    with pytest.raises(ModelRetry, match="3000×2000") as failure:
        await read_tools(FakeProbe()).read_media_file(
            make_context(make_deps()),
            OSS_IMAGE,
            region=CropRegion(x=3000, y=0, width=100, height=100),
        )

    assert "重算坐标" in str(failure.value)


async def test_full_resolution_over_the_limit_points_at_region() -> None:
    """整幅原分辨率有上限；报错要给一条出路，不然模型只会把同一次调用重试到底。"""

    probe = FakeProbe(
        ImageInfo(
            media_type="image/png",
            size_bytes=FULL_RESOLUTION_MAX_BYTES + 1,
            width=8000,
            height=6000,
        )
    )
    with pytest.raises(ModelRetry, match="region") as failure:
        await read_tools(probe).read_media_file(
            make_context(make_deps()), OSS_IMAGE, full_resolution=True
        )

    assert "10.0 MB" in str(failure.value)


async def test_full_resolution_under_the_limit_hands_over_the_bare_address() -> None:
    result = await read_tools(FakeProbe()).read_media_file(
        make_context(make_deps()), OSS_IMAGE, full_resolution=True
    )

    assert model_facing(result) == [
        f'<image url="{OSS_IMAGE}">',
        "原图 3000×2000 像素，image/jpeg，2.0 KB；原分辨率。",
        ImageUrl(url=OSS_IMAGE, media_type="image/jpeg"),
        "</image>",
    ]


async def test_region_and_full_resolution_are_mutually_exclusive() -> None:
    """两个都给就没法判断该裁还是该给整幅；说清二选一，别自己挑一个。"""

    with pytest.raises(ModelRetry, match="二选一"):
        await read_tools(FakeProbe()).read_media_file(
            make_context(make_deps()),
            OSS_IMAGE,
            region=CropRegion(x=0, y=0, width=10, height=10),
            full_resolution=True,
        )


async def test_an_unreachable_image_is_refused_before_the_model_sees_it() -> None:
    """问不出原图信息就别附给模型：报错发生在厂商那侧更难查。"""

    with pytest.raises(ModelRetry, match="读不了") as failure:
        await read_tools(FakeProbe(error="地址访问不到")).read_media_file(
            make_context(make_deps()), OSS_IMAGE
        )

    assert "换一个对话里出现过的图片地址" in str(failure.value)


async def test_an_address_that_cannot_carry_scaling_is_refused() -> None:
    """缩放参数挂不上去就别附：一张原图整幅进上下文只会让账单涨。"""

    with pytest.raises(ModelRetry, match="读不了"):
        await read_tools(FakeProbe()).read_media_file(
            make_context(make_deps()), "https://cdn.test/no-extension"
        )


async def test_read_media_file_takes_an_address_a_tool_wrote_down() -> None:
    """预览板地址由出板的那件工具记进台账，读图这一侧照样收得下。"""

    board = "https://bucket.oss-cn-hangzhou.aliyuncs.com/shot-frames/k/board/1.jpg"
    tools = read_tools(FakeProbe(), image_ledger(board))
    ctx = make_context(make_deps())

    await check_args(tools, ctx, url=board)
    assert await tools.read_media_file(ctx, board)

    with pytest.raises(ModelRetry, match="不是这段对话里的素材"):
        await check_args(
            tools,
            ctx,
            url="https://bucket.oss-cn-hangzhou.aliyuncs.com/shot-frames/k/board/9.jpg",
        )


async def test_an_out_of_scope_address_is_refused_before_the_probe_runs() -> None:
    """模型编一个地址：官方在执行之前跑验证器，工具体一次都没跑。"""

    probe = FakeProbe()
    tools = read_tools(probe, image_ledger(OSS_IMAGE))
    ctx = make_context(make_deps())

    await check_args(tools, ctx, url=OSS_IMAGE)
    with pytest.raises(ModelRetry, match="不是这段对话里的素材") as failure:
        await check_args(tools, ctx, url="https://cdn.test/made-up.jpg")

    # 不回显被拒的地址：回显一次，模型重试时它就成了「台账里有过」的东西。
    assert "made-up" not in str(failure.value)


async def test_a_video_address_cannot_be_read_as_an_image() -> None:
    """用户发的是视频，拿去读图——台账每行都带种类，认得出来。"""

    video = "https://cdn.test/ref.mp4"
    ledger = FakeMaterialLedger()
    ledger.rows[(NS, video)] = Material(url=video, kind="video")
    with pytest.raises(ModelRetry, match="视频"):
        await check_args(read_tools(FakeProbe(), ledger), make_context(make_deps()), url=video)


@pytest.mark.parametrize("url", ["style.jpg", "file:///etc/passwd", "ftp://host/a.jpg"])
async def test_read_media_file_only_takes_http_urls(url: str) -> None:
    with pytest.raises(ModelRetry, match="http"):
        await check_args(read_tools(FakeProbe()), make_context(make_deps()), url=url)


# --------------------------------------------------------------------------
# 能力的装配面
# --------------------------------------------------------------------------


def test_capability_has_a_stable_id(capability: Workspace[object]) -> None:
    """``for_run`` 每次返新实例，官方按 id 认能力，所以 id 必须写死。"""

    assert capability.id == CAPABILITY_ID
    assert WorkspaceToolset(capability).id == CAPABILITY_ID


def test_capability_opts_out_of_spec_construction() -> None:
    """不关掉的话，官方默认拿类名当序列化名，等于宣称自己能从 YAML 造出来。"""

    assert Workspace.get_serialization_name() is None


def test_capability_guidance_says_only_what_no_docstring_can(
    capability: Workspace[object],
) -> None:
    """指引只说「这个工作区是什么、归谁」。

    怎么用那七件工具已经写在各自的 docstring 与错误消息里；指引每轮都进上下文，
    在这儿重复一遍就是每轮都付一次钱。
    """

    instructions = capability.get_instructions()
    assert isinstance(instructions, str)
    assert "工作目录" in instructions
    for tool_name in ("read_file", "write_file", "edit_file", "delete_file", "list_files"):
        assert tool_name not in instructions


def test_every_tool_has_a_display(capability: Workspace[object]) -> None:
    """七件工具每件都登记了画法，kind 由客户端认。字段取不到就交给注册表退回 generic。"""

    drawn = ToolDisplayRegistry.merged(capability.display_table()).entries
    assert sorted(drawn) == [
        "ReadMediaFile",
        "delete_file",
        "edit_file",
        "list_files",
        "read_file",
        "search_files",
        "write_file",
    ]
    assert drawn["ReadMediaFile"].draw({"url": OSS_IMAGE}) == UrlFetchDisplay(url=OSS_IMAGE)
    # 地址取不到就交给注册表退回 generic，不画一张指着空地址的卡。
    assert drawn["ReadMediaFile"].draw({}) is None
    assert drawn["read_file"].draw({"path": "分镜.md"}) == FileIoDisplay(
        operation="read", path="分镜.md"
    )
    assert drawn["write_file"].draw({"path": "分镜.md"}) == FileIoDisplay(
        operation="write", path="分镜.md"
    )
    assert drawn["edit_file"].draw({"path": "分镜.md"}) == FileIoDisplay(
        operation="edit", path="分镜.md"
    )
    # 协议的 operation 联合里没有「删」，删文件只能画成朴素的那张卡。
    assert drawn["delete_file"].draw({"path": "分镜.md"}) == GenericDisplay(
        summary="删除文件 分镜.md"
    )
    assert drawn["search_files"].draw({"query": "门厅"}) == SearchDisplay(query="门厅")
    # 列目录没给前缀就是整个工作区。
    assert drawn["list_files"].draw({}) == FileIoDisplay(operation="glob", path="/")
    assert drawn["list_files"].draw({"prefix": "分镜"}) == FileIoDisplay(
        operation="glob", path="分镜"
    )
    for tool_name in ("read_file", "write_file", "edit_file", "delete_file", "search_files"):
        assert drawn[tool_name].draw({}) is None


def test_only_the_three_readable_results_pick_a_renderer(capability: Workspace[object]) -> None:
    """结果有专门渲染器的只有读文件、检索与读图三件，其余不给、前端走 generic。"""

    views = ToolDisplayRegistry.merged(capability.display_table())
    assert views.view_of("read_file") == "file_content"
    assert views.view_of("search_files") == "search_results"
    assert views.view_of("ReadMediaFile") == "media_grid"
    for tool_name in ("write_file", "edit_file", "delete_file", "list_files"):
        assert views.view_of(tool_name) is None


async def test_capability_attaches_to_a_real_agent(store: FakeFileStore) -> None:
    """挂到真 Agent 上跑一次。

    装配面上的错——dataclass 字段顺序、``for_run`` 的签名、工具集有没有真的被
    官方接进去——直接调工具集是验不出来的，只有让框架自己走一遍才暴露。
    """

    seen: list[tuple[str, ...]] = []

    def script(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        seen.append(tuple(tool.name for tool in info.function_tools))
        if len(seen) == 1:
            return ModelResponse(
                parts=[ToolCallPart("write_file", {"path": "稿.md", "content": "夜景"})]
            )
        if len(seen) == 2:
            return ModelResponse(parts=[ToolCallPart("list_files", {})])
        return ModelResponse(parts=[TextPart("写完了")])

    agent = Agent(
        FunctionModel(script),
        deps_type=AgentRunDeps,
        capabilities=[make_workspace(store)],
    )
    result = await agent.run("起个稿", deps=make_deps())

    assert result.output == "写完了"
    # 七件工具都到了模型面前。
    assert set(seen[0]) == {
        "read_file",
        "write_file",
        "edit_file",
        "delete_file",
        "list_files",
        "search_files",
        "ReadMediaFile",
    }
    # 文件真的落进了「这个用户的这段对话」名下。
    stored = await store.read(NS, "稿.md")
    assert stored is not None and stored.content == "夜景"


async def test_a_subagent_shares_the_conversation_workspace(store: FakeFileStore) -> None:
    """下属写的稿子，主 agent 读得到——这是「一段对话一个工作区」要的那个效果。

    派活是**另起一次运行**，所以这条不是显然的。官方转发 deps 但不转发运行自己
    的 ``conversation_id``（实测过），工作区因此从 deps 取对话 id；要是改成读
    ``ctx.conversation_id``，下属就会拿到一个新生成的 id、写进另一个文件夹，主
    agent 什么都读不到，而且不会报错——白干一场，静默。
    """

    workspace = make_workspace(store)

    def child_script(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        if not any(isinstance(message, ModelResponse) for message in messages):
            return ModelResponse(
                parts=[ToolCallPart("write_file", {"path": "分镜/第一集.md", "content": "镜头一"})]
            )
        return ModelResponse(parts=[TextPart("下属写完了")])

    worker = Agent(
        FunctionModel(child_script),
        name="worker",
        deps_type=AgentRunDeps,
        capabilities=[workspace],
    )

    turns: list[str] = []

    def parent_script(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        turns.append("turn")
        if len(turns) == 1:
            return ModelResponse(
                parts=[ToolCallPart("delegate_task", {"agent_name": "worker", "task": "写第一集"})]
            )
        if len(turns) == 2:
            return ModelResponse(parts=[ToolCallPart("read_file", {"path": "分镜/第一集.md"})])
        return ModelResponse(parts=[TextPart("我读到了下属写的稿子")])

    boss = Agent(
        FunctionModel(parent_script),
        name="boss",
        deps_type=AgentRunDeps,
        capabilities=[workspace, SubAgents(agents=[SubAgent(worker)], agent_folders=None)],
    )

    result = await boss.run("安排下去", deps=make_deps())

    # 断言落在「没有产生重试」上：只看最终输出是不够的——文件不在的时候
    # read_file 抛的是 ModelRetry，模型收下重试提示接着往下走，最终输出照样是
    # 那句话，一条静默失败就这么被漏过去了。
    retries = [
        part
        for message in result.all_messages()
        for part in message.parts
        if isinstance(part, RetryPromptPart)
    ]
    assert retries == [], f"主 agent 读不到下属写的文件: {retries}"
    assert result.output == "我读到了下属写的稿子"
    # 文件就落在「这个用户的这段对话」名下，不在下属自己新开的地方。
    stored = await store.read(NS, "分镜/第一集.md")
    assert stored is not None and stored.content == "镜头一"
    assert [entry.path for entry in await store.entries(NS)] == ["分镜/第一集.md"]
