"""工作区能力：给 agent 一个跨会话持久的文本工作面。

按官方 capability 的写法长：``AbstractCapability`` 的子类，贡献一个工具集加一
段静态指引；文件落在哪由组合根注入的 ``FileSpace`` 决定（平台层的存储协议 + 一
条算命名空间的规则），所以这里既不认识 Postgres，也不认识我们的表，更不需要知道
「租户」在这个系统里是用什么表示的。

不实现 ``from_spec``，并且把 ``get_serialization_name`` 显式关成 ``None``：官方
的默认值是类名，也就是说不关就等于对外宣称「我能从 YAML spec 里造出来」，而
``FileSpace`` 是运行期对象，造不出来。声明面在上一层——``agents.yaml``
里写 ``capabilities: [workspace]``。

也不做 ``before_model_request`` 注入。官方 ``Memory`` 往每轮请求里塞记忆是因为
那本来就是「上一次会话的背景」；工作区的文件清单没有这个必要性，模型要看就调
``list_files``，省一份每轮都付钱的噪音。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Final, Literal

from pydantic_ai import ModelRetry
from pydantic_ai.agent.abstract import AgentInstructions
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.tools import AgentDepsT, RunContext
from pydantic_ai.toolsets import AgentToolset, FunctionToolset

from iclip.platform.file_store.store import (
    FileEntry,
    FileSpace,
    InvalidContent,
    InvalidPath,
    QuotaExceeded,
    VersionConflict,
    normalize_path,
)
from iclip.platform.transcript.display import (
    DisplayFn,
    FileIoDisplay,
    GenericDisplay,
    SearchDisplay,
    ToolDisplay,
)

CAPABILITY_ID: Final = "workspace"
"""能力与工具集共用的稳定 id。

``for_run`` 每次运行都返回一个新实例，而官方按 id 认能力（不是按对象），所以
它必须是写死的字符串而不是派生值。工具集用同一个 id，durable execution 按 id
包工具集时才包得住。
"""

MAX_READ_LINES: Final = 400
MAX_SEARCH_RESULTS: Final = 50

_GUIDANCE = "这段对话有一个持久的工作目录，你和你派出去的下属共用同一个根，所有路径都相对它。"
"""只说这个目录是什么。

路径怎么写、怎么用那六件工具，都写在各自的 docstring、参数描述与错误消息里了，
在这儿再说一遍就是每轮都要付钱的重复。这条界线见 `docs/tool-design.md` §0。
"""


@dataclass
class Workspace(AbstractCapability[AgentDepsT]):
    """把工作区工具集挂到 agent 上。"""

    space: FileSpace
    """文件落在哪：存储后端 + 从本次运行算命名空间的规则。

    命名空间做成规则而不是字符串，是为了让「按什么分工作区」这个决定留在组合
    根：那里才看得见身份是怎么表示的。规则抛异常就让它抛——算不出命名空间时唯
    一正确的行为是让这次运行失败，绝不能退回某个公共命名空间。
    """

    # 显式 kw_only：父类的 ``id`` 本来就是关键字字段，重新声明时得保持这一点，
    # 否则字段顺序会变成「有默认值的位置参数在前、没默认值的在后」而报错。
    id: str | None = field(default=CAPABILITY_ID, kw_only=True)

    _scope: str | None = field(default=None, init=False, repr=False, compare=False)

    async def for_run(self, ctx: RunContext[AgentDepsT]) -> Workspace[AgentDepsT]:
        """每次运行克隆一份，并当场把命名空间算出来。

        算这一次的意义不是省几次函数调用，而是**在第一次模型请求之前、每次运
        行都确定性地失败**——而不是等模型碰巧去碰了工作区工具，才在一个工具错
        误里暴露「这次运行的身份不对」。
        """

        clone = replace(self)
        clone._scope = clone._resolve_scope(ctx)
        return clone

    def resolve_scope(self, ctx: RunContext[AgentDepsT]) -> str:
        """取本次运行的命名空间。"""

        if self._scope is not None:
            return self._scope
        return self._resolve_scope(ctx)

    def _resolve_scope(self, ctx: RunContext[AgentDepsT]) -> str:
        return self.space.resolve(ctx)

    def get_toolset(self) -> AgentToolset[AgentDepsT] | None:
        return WorkspaceToolset(self)

    def get_instructions(self) -> AgentInstructions[AgentDepsT] | None:
        return _GUIDANCE

    def display_table(self) -> Mapping[str, DisplayFn]:
        """这六件工具的卡怎么画。组合根装配期取一次，合进那份注册表。"""

        return {
            "read_file": lambda args: _file_io("read", _text(args, "path")),
            "write_file": lambda args: _file_io("write", _text(args, "path")),
            "edit_file": lambda args: _file_io("edit", _text(args, "path")),
            # 列目录按 glob 画；协议的 operation 联合里没有「删」，删文件走 generic。
            "list_files": lambda args: _file_io("glob", _text(args, "prefix") or "/"),
            "delete_file": _delete_display,
            "search_files": _search_display,
        }

    @classmethod
    def get_serialization_name(cls) -> str | None:
        return None


def _text(args: Any, field_name: str) -> str | None:
    """从这次调用的参数里取一个非空字符串。"""

    if isinstance(args, dict):
        value = args.get(field_name)
        if isinstance(value, str) and value:
            return value
    return None


def _file_io(
    operation: Literal["read", "write", "edit", "glob", "grep"], path: str | None
) -> ToolDisplay | None:
    return None if path is None else FileIoDisplay(operation=operation, path=path)


def _delete_display(args: Any) -> ToolDisplay | None:
    path = _text(args, "path")
    return None if path is None else GenericDisplay(summary=f"删除文件 {path}")


def _search_display(args: Any) -> ToolDisplay | None:
    query = _text(args, "query")
    return None if query is None else SearchDisplay(query=query)


def _checked(path: str) -> str:
    """把路径语法错误翻成模型能自己改的重试。

    存储层也会校验一遍——那里是协议边界，将来多一个调用方也绕不过去。这里再
    校验是为了错误消息：同一件事在这一层是「让模型改」，在那一层是「拒绝非法
    输入」。
    """

    try:
        return normalize_path(path)
    except InvalidPath as exc:
        raise ModelRetry(str(exc)) from exc


class WorkspaceToolset(FunctionToolset[AgentDepsT]):
    """工作区的六件工具。命名空间不在任何一个工具的参数里。"""

    def __init__(self, capability: Workspace[AgentDepsT]) -> None:
        super().__init__(id=CAPABILITY_ID)
        self._capability = capability
        self.add_function(self.read_file, name="read_file")
        self.add_function(self.write_file, name="write_file")
        self.add_function(self.edit_file, name="edit_file")
        self.add_function(self.delete_file, name="delete_file")
        self.add_function(self.list_files, name="list_files")
        self.add_function(self.search_files, name="search_files")

    async def read_file(
        self, ctx: RunContext[AgentDepsT], path: str, offset: int = 1, limit: int = MAX_READ_LINES
    ) -> str:
        """读一个工作区文件，返回带行号的内容。

        Args:
            ctx: 框架给的运行上下文。
            path: 文件路径，如 ``分镜/第一集.md``。
            offset: 从第几行开始读，1 起算。
            limit: 最多读多少行。
        """

        key = _checked(path)
        scope = self._capability.resolve_scope(ctx)
        stored = await self._capability.space.store.read(scope, key)
        if stored is None:
            raise ModelRetry(f"工作区里没有 {key!r}。用 list_files 看看有哪些文件。")
        if offset < 1:
            raise ModelRetry("offset 从 1 起算。")
        capped = min(limit, MAX_READ_LINES)
        lines = stored.content.splitlines()
        window = lines[offset - 1 : offset - 1 + capped]
        if not window:
            raise ModelRetry(f"{key!r} 只有 {len(lines)} 行，读不到第 {offset} 行。")
        numbered = "\n".join(f"{offset + index:>6}\t{line}" for index, line in enumerate(window))
        remaining = len(lines) - (offset - 1 + len(window))
        if remaining > 0:
            numbered += f"\n[还有 {remaining} 行没读，接着从第 {offset + len(window)} 行读]"
        return numbered

    async def write_file(self, ctx: RunContext[AgentDepsT], path: str, content: str) -> str:
        """写一个工作区文件，已存在就整份覆盖。

        覆盖就是覆盖：别人（或你自己上一轮）改过的内容会一起没掉。只改其中一
        段就用 ``edit_file``，那条路径带并发保护。只放文本，图片和音视频不要写
        进来。

        Args:
            ctx: 框架给的运行上下文。
            path: 文件路径，如 ``分镜/第一集.md``。
            content: 文件全文。
        """

        key = _checked(path)
        scope = self._capability.resolve_scope(ctx)
        entry = await self._write(scope, key, content)
        return f"已写入 {entry.path}（{entry.size_bytes} 字节）"

    async def edit_file(
        self, ctx: RunContext[AgentDepsT], path: str, old_text: str, new_text: str
    ) -> str:
        """把文件里的一段文本替换掉，``old_text`` 必须恰好出现一次。

        改一处就用它，别把整份稿子重写一遍。``old_text`` 要连标点和空白一起照
        抄；不唯一时把上下文多带几行进来。

        Args:
            ctx: 框架给的运行上下文。
            path: 文件路径，如 ``分镜/第一集.md``。
            old_text: 要被替换掉的原文，须与文件内容逐字符一致。
            new_text: 替换成什么。留空即删掉这一段。
        """

        key = _checked(path)
        if not old_text:
            raise ModelRetry("old_text 不能为空；要新建或整份覆盖就用 write_file。")
        scope = self._capability.resolve_scope(ctx)
        stored = await self._capability.space.store.read(scope, key)
        if stored is None:
            raise ModelRetry(f"工作区里没有 {key!r}。要新建就用 write_file。")
        occurrences = stored.content.count(old_text)
        if occurrences == 0:
            raise ModelRetry(
                f"{key!r} 里找不到这段原文。先用 read_file 看一眼实际内容再改（空白和标点要照抄）。"
            )
        if occurrences > 1:
            raise ModelRetry(
                f"这段原文在 {key!r} 里出现了 {occurrences} 次，不知道该改哪一处。"
                "把上下文多带几行进 old_text，让它唯一。"
            )
        # 带上读到的版本号写回去：这是「读—改—写」，中间被人插一刀就该失败，
        # 而不是把别人的改动盖掉。版本号不进工具参数——模型不该管这个。
        entry = await self._write(
            scope, key, stored.content.replace(old_text, new_text), expected_version=stored.version
        )
        return f"已改 {entry.path}（现在 {entry.size_bytes} 字节）"

    async def delete_file(self, ctx: RunContext[AgentDepsT], path: str) -> str:
        """删掉一个不再需要的工作区文件。

        Args:
            ctx: 框架给的运行上下文。
            path: 文件路径。
        """

        key = _checked(path)
        scope = self._capability.resolve_scope(ctx)
        if not await self._capability.space.store.delete(scope, key):
            raise ModelRetry(f"工作区里没有 {key!r}，无从删除。")
        return f"已删除 {key}"

    async def list_files(self, ctx: RunContext[AgentDepsT], prefix: str = "") -> str:
        """列出工作区里的文件。

        接手一段对话先用它看看已经攒了什么，别从零重来。

        Args:
            ctx: 框架给的运行上下文。
            prefix: 只看某个目录下的，如 ``分镜``。留空即全部。
        """

        scope = self._capability.resolve_scope(ctx)
        entries = await self._entries(scope, prefix)
        if not entries:
            where = "工作区" if not prefix else f"{prefix!r} 下"
            return f"{where}还没有任何文件。"
        return "\n".join(f"{entry.path}\t{entry.size_bytes} 字节" for entry in entries)

    async def search_files(self, ctx: RunContext[AgentDepsT], query: str, limit: int = 20) -> str:
        """在工作区的文件内容里检索一个字符串，返回命中的行。

        大小写不敏感，按字面量匹配（不是正则）。同一个文件最多报前几处命中。

        Args:
            ctx: 框架给的运行上下文。
            query: 要找的文本。
            limit: 最多返回多少条命中。
        """

        if not query:
            raise ModelRetry("要检索的文本不能为空。")
        scope = self._capability.resolve_scope(ctx)
        result = await self._capability.space.store.search(
            scope, query, limit=min(limit, MAX_SEARCH_RESULTS)
        )
        if not result.matches:
            return f"工作区里没有包含 {query!r} 的内容。"
        lines = [f"{match.path}:{match.line}\t{match.snippet}" for match in result.matches]
        if result.truncated:
            lines.append("[命中较多，只报了一部分；把检索词写得更具体一些]")
        return "\n".join(lines)

    async def _write(
        self, scope: str, key: str, content: str, *, expected_version: int | None = None
    ) -> FileEntry:
        """写入并把存储层的失败翻成模型能自己处理的重试。"""

        try:
            return await self._capability.space.store.write(
                scope, key, content, expected_version=expected_version
            )
        except InvalidContent as exc:
            raise ModelRetry(str(exc)) from exc
        except QuotaExceeded as exc:
            if exc.scope == "file":
                raise ModelRetry(f"{exc}。把内容拆成几个文件，或者精简一些。") from exc
            raise ModelRetry(f"{exc}。用 list_files 找出不再需要的文件删掉。") from exc
        except VersionConflict as exc:
            raise ModelRetry(f"{exc}。用 read_file 重新读一遍，再基于新内容改。") from exc

    async def _entries(self, scope: str, prefix: str) -> Sequence[FileEntry]:
        try:
            return await self._capability.space.store.entries(scope, prefix=prefix)
        except InvalidPath as exc:
            raise ModelRetry(str(exc)) from exc


def workspace_capability(*, space: FileSpace) -> Workspace[Any]:
    """造一个工作区能力。组合根用这个，不直接碰 dataclass 的字段顺序。"""

    return Workspace[Any](space=space)


__all__ = [
    "CAPABILITY_ID",
    "MAX_READ_LINES",
    "MAX_SEARCH_RESULTS",
    "Workspace",
    "WorkspaceToolset",
    "workspace_capability",
]
