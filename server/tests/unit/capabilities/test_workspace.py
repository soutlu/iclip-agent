"""验证工作区工具的路径边界、错误映射和命名空间隔离；存储与图片探针使用内存替身。"""

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
    """返回固定图片信息或抛出预设异常。"""

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

    return RunContext[object](deps=deps, model=TestModel(), usage=RunUsage(), messages=[])


def image_ledger(*urls: str) -> FakeMaterialLedger:
    """模拟收件阶段已登记的图片素材。"""

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
    """提取面向模型的工具结果；return_value 联合类型需先经 isinstance 收窄。"""

    value = result.return_value
    assert isinstance(value, list)
    return list(value)


def text(result: ToolReturn) -> str:
    """文本工具给模型的正文；卡片用的 metadata 另行断言。"""

    value = result.return_value
    assert isinstance(value, str)
    return value


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
    """工作区使用逻辑路径，无本地 inode；越界检查依赖路径语法。"""

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
    """预组合字符与组合字符须归一化，避免同一文件名产生两份文件。"""

    assert normalize_path("caf\u00e9.md") == normalize_path("cafe\u0301.md")


def test_namespace_is_the_conversation_under_the_trusted_user() -> None:
    """客户端提供的对话 id 仅作次级命名空间，外层使用可信用户 id。"""

    assert workspace_namespace(make_context(make_deps())) == f"{USER}/{THREAD}"


def test_namespace_fails_closed_when_deps_is_not_a_run_deps() -> None:
    """缺少运行身份属于装配错误，公共命名空间会破坏用户隔离。"""

    with pytest.raises(RuntimeError, match="不是 AgentRunDeps"):
        workspace_namespace(make_context({"user_id": str(USER)}))


def test_a_forged_conversation_id_cannot_escape_its_user() -> None:

    assert workspace_namespace(make_context(make_deps())).startswith(f"{USER}/")


def test_scope_goes_through_normalization() -> None:
    """命名空间须经 FileSpace.resolve 归一化，保证共享 FileSpace 的能力访问同一位置。"""

    dirty = FileSpace(store=FakeFileStore(), namespace=lambda _ctx: f"{USER}//{THREAD}")
    capability = workspace_capability(space=dirty, probe=FakeProbe(), ledger=FakeMaterialLedger())
    assert capability.resolve_scope(make_context(make_deps())) == NS


async def test_for_run_resolves_scope_before_any_tool_is_touched(
    capability: Workspace[object],
) -> None:
    """运行身份在 for_run 阶段校验，不能依赖模型是否调用工作区工具。"""

    with pytest.raises(RuntimeError, match="不是 AgentRunDeps"):
        await capability.for_run(make_context("这不是运行依赖"))


async def test_two_users_do_not_see_each_other(
    tools: WorkspaceToolset[object], store: FakeFileStore
) -> None:
    mine = make_context(make_deps())
    theirs = make_context(make_deps(OTHER_USER))
    await tools.write_file(mine, "笔记.md", "我的稿子")
    assert "笔记.md" in text(await tools.list_files(mine))
    assert text(await tools.list_files(theirs)) == "工作区还没有任何文件。"
    assert await store.read(f"{OTHER_USER}/{THREAD}", "笔记.md") is None


async def test_two_conversations_of_one_user_do_not_see_each_other(
    tools: WorkspaceToolset[object],
) -> None:

    here = make_context(make_deps())
    there = make_context(make_deps(conversation_id=OTHER_THREAD))
    await tools.write_file(here, "笔记.md", "这段对话的稿子")
    assert text(await tools.list_files(there)) == "工作区还没有任何文件。"


async def test_write_then_read_round_trip(
    tools: WorkspaceToolset[object], ctx: RunContext[object]
) -> None:
    assert "已写入 分镜/第一集.md" in text(
        await tools.write_file(ctx, "分镜/第一集.md", "镜头一\n镜头二")
    )
    assert text(await tools.read_file(ctx, "分镜/第一集.md")) == "     1\t镜头一\n     2\t镜头二"


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
    assert "     3\t第3行" in text(page)
    assert "     4\t第4行" in text(page)
    assert "还有 6 行没读" in text(page)
    # 卡片只拿范围，正文仍在 output 里，不重复一份。
    assert page.metadata == {"path": "长稿.md", "lines": 2, "truncated": True}
    whole = await tools.read_file(ctx, "长稿.md")
    assert whole.metadata == {"path": "长稿.md", "lines": 10, "truncated": False}


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
    edited = await tools.edit_file(ctx, "稿.md", "夜景", "黄昏")
    assert "开场是黄昏" in text(await tools.read_file(ctx, "稿.md"))
    # 卡尾角标：改了一行算一增一删。
    assert edited.metadata == {"added": 1, "removed": 1}


async def test_edit_refuses_an_ambiguous_match(
    tools: WorkspaceToolset[object], ctx: RunContext[object]
) -> None:

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
    """edit_file 的读改写间存在并发窗口，版本冲突必须保留其他运行的修改。"""

    class RacingStore(FakeFileStore):
        async def read(self, namespace: str, path: str) -> StoredFile | None:
            found = await super().read(namespace, path)
            # 模拟读取后、写回前发生并发更新。
            await super().write(namespace, path, "别人写的内容")
            return found

    racing = RacingStore()
    await racing.write(NS, "稿.md", "夜景")
    tools = WorkspaceToolset(make_workspace(racing))
    with pytest.raises(ModelRetry, match="重新读一遍"):
        await tools.edit_file(ctx, "稿.md", "夜景", "黄昏")


async def test_write_reports_the_size_as_a_chip(
    tools: WorkspaceToolset[object], ctx: RunContext[object]
) -> None:
    small = await tools.write_file(ctx, "稿.md", "夜景")
    assert small.metadata == {"chip": "6 B"}
    big = await tools.write_file(ctx, "长稿.md", "x" * 2048)
    assert big.metadata == {"chip": "2.0 KB"}


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

    await tools.write_file(ctx, "分镜/第一集.md", "a")
    await tools.write_file(ctx, "分镜稿.md", "b")
    listed = await tools.list_files(ctx, prefix="分镜")
    assert "分镜/第一集.md" in text(listed)
    assert "分镜稿.md" not in text(listed)
    assert listed.metadata == {"chip": "1 个文件"}


async def test_search_reports_the_matching_lines(
    tools: WorkspaceToolset[object], ctx: RunContext[object]
) -> None:
    await tools.write_file(ctx, "稿.md", "开场是夜景\n中段是雨\n结尾也是夜景")
    found = await tools.search_files(ctx, "夜景")
    assert "稿.md:1" in text(found)
    assert "稿.md:3" in text(found)
    assert "稿.md:2" not in text(found)
    # 卡身逐条画命中行，拿的是结构化的那份。
    assert found.metadata == {
        "query": "夜景",
        "truncated": False,
        "matches": [
            {"file": "稿.md", "line": 1, "text": "开场是夜景"},
            {"file": "稿.md", "line": 3, "text": "结尾也是夜景"},
        ],
    }


async def test_search_is_case_insensitive_and_literal(
    tools: WorkspaceToolset[object], ctx: RunContext[object]
) -> None:
    await tools.write_file(ctx, "稿.md", "SCENE 100%\n别的行")
    assert "稿.md:1" in text(await tools.search_files(ctx, "scene"))
    assert "没有包含" in text(await tools.search_files(ctx, "%别的"))


async def test_search_without_hits_says_so(
    tools: WorkspaceToolset[object], ctx: RunContext[object]
) -> None:
    await tools.write_file(ctx, "稿.md", "夜景")
    missed = await tools.search_files(ctx, "雨景")
    assert "没有包含" in text(missed)
    assert missed.metadata == {"query": "雨景", "truncated": False, "matches": []}


async def test_search_flags_that_it_held_matches_back(
    tools: WorkspaceToolset[object], ctx: RunContext[object]
) -> None:
    await tools.write_file(ctx, "a.md", "夜景")
    await tools.write_file(ctx, "b.md", "夜景")
    found = await tools.search_files(ctx, "夜景", limit=1)
    assert "只报了一部分" in text(found)


async def test_oversized_file_is_refused_with_the_file_limit(ctx: RunContext[object]) -> None:
    tools = WorkspaceToolset(make_workspace(FakeFileStore(max_file_bytes=100)))
    with pytest.raises(ModelRetry, match="超过单文件上限"):
        await tools.write_file(ctx, "稿.md", "x" * 101)


async def test_full_workspace_tells_the_model_how_to_recover(ctx: RunContext[object]) -> None:

    tools = WorkspaceToolset(make_workspace(FakeFileStore(max_namespace_bytes=100)))
    await tools.write_file(ctx, "a.md", "x" * 80)
    with pytest.raises(ModelRetry, match="删掉"):
        await tools.write_file(ctx, "b.md", "y" * 80)
    assert "已写入 a.md" in text(await tools.write_file(ctx, "a.md", "z" * 90))


async def test_quota_and_conflict_are_distinguishable(store: FakeFileStore) -> None:
    """容量不足需要清理文件，版本冲突需要重新读取；二者必须保持不同错误类型。"""

    small = FakeFileStore(max_namespace_bytes=10)
    with pytest.raises(QuotaExceeded):
        await small.write(NS, "a.md", "x" * 20)
    await store.write(NS, "a.md", "x")
    with pytest.raises(VersionConflict):
        await store.write(NS, "a.md", "y", expected_version=99)


def read_tools(
    probe: FakeProbe, ledger: FakeMaterialLedger | None = None
) -> WorkspaceToolset[object]:
    return WorkspaceToolset(make_workspace(FakeFileStore(), probe, ledger))


async def check_args(
    tools: WorkspaceToolset[object], ctx: RunContext[object], **args: object
) -> None:
    """通过工具注册表调用校验器，覆盖 args_validator 的挂载遗漏。"""

    validator = tools.tools["ReadMediaFile"].args_validator
    assert validator is not None, "ReadMediaFile 登记时没挂验证器"
    outcome = validator(ctx, **args)
    assert inspect.isawaitable(outcome), "本包的验证器都是 async 的"
    await outcome


async def test_a_big_image_is_downsampled_and_says_so() -> None:
    """降采样结果必须包含原图尺寸与缩放说明，避免模型误用缩略图坐标。"""

    result = await read_tools(FakeProbe()).read_media_file(make_context(make_deps()), OSS_IMAGE)

    assert model_facing(result) == [
        f'<image url="{OSS_IMAGE}">',
        "原图 3000×2000 像素，image/jpeg，2.0 KB；已降采样到长边 1024。"
        "要看清小字或细节，用 `region` 按原图像素坐标看一块。输出坐标一律按原图尺寸算。",
        ImageUrl(url=f"{OSS_IMAGE}?x-oss-process=image/resize,l_1024", media_type="image/jpeg"),
        "</image>",
    ]
    # 卡片：交付的是处理过的图就在角标说明。
    assert result.metadata == {
        "items": [
            {
                "url": f"{OSS_IMAGE}?x-oss-process=image/resize,l_1024",
                "caption": "已降采样到长边 1024",
            }
        ],
        "note": "已处理",
    }


async def test_a_small_image_goes_untouched() -> None:
    """长边不超过 1024 时无需缩放，OSS 也不会放大原图。"""

    probe = FakeProbe(ImageInfo(media_type="image/png", size_bytes=1536, width=800, height=600))
    result = await read_tools(probe).read_media_file(make_context(make_deps()), OSS_IMAGE)

    assert model_facing(result) == [
        f'<image url="{OSS_IMAGE}">',
        "原图 800×600 像素，image/png，1.5 KB；未缩放。",
        ImageUrl(url=OSS_IMAGE, media_type="image/png"),
        "</image>",
    ]


async def test_a_region_crops_in_original_coordinates_and_flags_the_offset() -> None:
    """裁切使用原图坐标，超出图像边界的区域按实际尺寸报告；长边超过 1024 再缩放。"""

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

    result = await read_tools(FakeProbe()).read_media_file(
        make_context(make_deps()), OSS_IMAGE, region=CropRegion(x=10, y=20, width=200, height=100)
    )

    assert model_facing(result)[2] == ImageUrl(
        url=f"{OSS_IMAGE}?x-oss-process=image/crop,x_10,y_20,w_200,h_100",
        media_type="image/jpeg",
    )
    assert "已降采样" not in str(model_facing(result)[1])


async def test_a_region_starting_outside_the_image_reports_the_real_size() -> None:
    """图外起点会产生空图；错误需携带原图尺寸以便修正。"""

    with pytest.raises(ModelRetry, match="3000×2000") as failure:
        await read_tools(FakeProbe()).read_media_file(
            make_context(make_deps()),
            OSS_IMAGE,
            region=CropRegion(x=3000, y=0, width=100, height=100),
        )

    assert "重算坐标" in str(failure.value)


async def test_full_resolution_over_the_limit_points_at_region() -> None:
    """原分辨率超限时提示使用 region，避免重复提交同一无效请求。"""

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

    with pytest.raises(ModelRetry, match="二选一"):
        await read_tools(FakeProbe()).read_media_file(
            make_context(make_deps()),
            OSS_IMAGE,
            region=CropRegion(x=0, y=0, width=10, height=10),
            full_resolution=True,
        )


async def test_an_unreachable_image_is_refused_before_the_model_sees_it() -> None:
    """在模型接收图片前拒绝探测失败的地址，避免错误延迟到模型供应商。"""

    with pytest.raises(ModelRetry, match="读不了") as failure:
        await read_tools(FakeProbe(error="地址访问不到")).read_media_file(
            make_context(make_deps()), OSS_IMAGE
        )

    assert "换一个对话里出现过的图片地址" in str(failure.value)


async def test_an_address_that_cannot_carry_scaling_is_refused() -> None:
    """不支持缩放参数的地址不能满足图片尺寸限制。"""

    with pytest.raises(ModelRetry, match="读不了"):
        await read_tools(FakeProbe()).read_media_file(
            make_context(make_deps()), "https://cdn.test/no-extension"
        )


async def test_read_media_file_takes_an_address_a_tool_wrote_down() -> None:

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
    """地址校验必须在工具执行和图片探测之前完成。"""

    probe = FakeProbe()
    tools = read_tools(probe, image_ledger(OSS_IMAGE))
    ctx = make_context(make_deps())

    await check_args(tools, ctx, url=OSS_IMAGE)
    with pytest.raises(ModelRetry, match="不是这段对话里的素材") as failure:
        await check_args(tools, ctx, url="https://cdn.test/made-up.jpg")

    # 不回显未登记地址，避免重试消息将其引入素材上下文。
    assert "made-up" not in str(failure.value)


async def test_a_video_address_cannot_be_read_as_an_image() -> None:

    video = "https://cdn.test/ref.mp4"
    ledger = FakeMaterialLedger()
    ledger.rows[(NS, video)] = Material(url=video, kind="video")
    with pytest.raises(ModelRetry, match="视频"):
        await check_args(read_tools(FakeProbe(), ledger), make_context(make_deps()), url=video)


@pytest.mark.parametrize("url", ["style.jpg", "file:///etc/passwd", "ftp://host/a.jpg"])
async def test_read_media_file_only_takes_http_urls(url: str) -> None:
    with pytest.raises(ModelRetry, match="http"):
        await check_args(read_tools(FakeProbe()), make_context(make_deps()), url=url)


def test_capability_has_a_stable_id(capability: Workspace[object]) -> None:
    """for_run 返回新实例；固定 id 保持框架对能力身份的识别。"""

    assert capability.id == CAPABILITY_ID
    assert WorkspaceToolset(capability).id == CAPABILITY_ID


def test_capability_opts_out_of_spec_construction() -> None:
    """运行时依赖不可从 YAML 构造，因此禁用 spec 构造。"""

    assert Workspace.get_serialization_name() is None


def test_capability_guidance_says_only_what_no_docstring_can(
    capability: Workspace[object],
) -> None:
    """指引只描述工作区归属；工具用法由 docstring 与错误消息提供，避免重复占用上下文。"""

    instructions = capability.get_instructions()
    assert isinstance(instructions, str)
    assert "工作目录" in instructions
    for tool_name in ("read_file", "write_file", "edit_file", "delete_file", "list_files"):
        assert tool_name not in instructions


def test_every_tool_has_a_display(capability: Workspace[object]) -> None:

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
    # 读图不是取网页：标题「读取图片」，主语是文件名。
    assert drawn["ReadMediaFile"].draw({"url": OSS_IMAGE}) == GenericDisplay(
        summary="读取图片", detail="style.jpg"
    )
    assert drawn["ReadMediaFile"].draw({}) is None
    assert drawn["read_file"].draw({"path": "分镜.md"}) == FileIoDisplay(
        operation="read", path="分镜.md"
    )
    # 写入与编辑把内容带给审批卡预览；参数没带时字段留空。
    assert drawn["write_file"].draw({"path": "分镜.md", "content": "夜景"}) == FileIoDisplay(
        operation="write", path="分镜.md", content="夜景"
    )
    assert drawn["edit_file"].draw(
        {"path": "分镜.md", "old_text": "夜景", "new_text": "黄昏"}
    ) == FileIoDisplay(operation="edit", path="分镜.md", before="夜景", after="黄昏")
    assert drawn["edit_file"].draw({"path": "分镜.md"}) == FileIoDisplay(
        operation="edit", path="分镜.md"
    )
    # operation 联合不含删除操作，删除工具使用 generic 展示：标题与主语分开。
    assert drawn["delete_file"].draw({"path": "分镜.md"}) == GenericDisplay(
        summary="删除文件", detail="分镜.md"
    )
    assert drawn["search_files"].draw({"query": "门厅"}) == SearchDisplay(query="门厅")
    assert drawn["list_files"].draw({}) == FileIoDisplay(operation="glob", path="/")
    assert drawn["list_files"].draw({"prefix": "分镜"}) == FileIoDisplay(
        operation="glob", path="分镜"
    )
    for tool_name in ("read_file", "write_file", "edit_file", "delete_file", "search_files"):
        assert drawn[tool_name].draw({}) is None


def test_only_the_three_readable_results_pick_a_renderer(capability: Workspace[object]) -> None:

    views = ToolDisplayRegistry.merged(capability.display_table())
    assert views.view_of("read_file") == "file_content"
    assert views.view_of("search_files") == "search_results"
    assert views.view_of("ReadMediaFile") == "media_grid"
    for tool_name in ("write_file", "edit_file", "delete_file", "list_files"):
        assert views.view_of(tool_name) is None


async def test_capability_attaches_to_a_real_agent(store: FakeFileStore) -> None:
    """通过真实 Agent 覆盖 for_run 签名、dataclass 初始化和工具集挂载。"""

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
    assert set(seen[0]) == {
        "read_file",
        "write_file",
        "edit_file",
        "delete_file",
        "list_files",
        "search_files",
        "ReadMediaFile",
    }
    stored = await store.read(NS, "稿.md")
    assert stored is not None and stored.content == "夜景"


async def test_a_subagent_shares_the_conversation_workspace(store: FakeFileStore) -> None:
    """子代理另起运行，仅继承 deps 中的对话 id；命名空间不得使用新的 ctx.conversation_id。"""

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

    # 最终输出无法识别被 ModelRetry 掩盖的读取失败，需额外确认未发生重试。
    retries = [
        part
        for message in result.all_messages()
        for part in message.parts
        if isinstance(part, RetryPromptPart)
    ]
    assert retries == [], f"主 agent 读不到下属写的文件: {retries}"
    assert result.output == "我读到了下属写的稿子"
    stored = await store.read(NS, "分镜/第一集.md")
    assert stored is not None and stored.content == "镜头一"
    assert [entry.path for entry in await store.entries(NS)] == ["分镜/第一集.md"]
