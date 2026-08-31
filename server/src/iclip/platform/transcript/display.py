"""工具卡怎么画：工具名 → 协议里的 ``display``。

**客户端不认工具名**，它只认这个字段里的 ``kind``（协议定死的一个封闭联合）。后端加一件工具，
前端不用跟着改——前提是这里给出了它的 kind。

认不出的一律 ``generic``：卡片画得朴素而已，不会画错。所以这张表可以慢慢补，不必一次配齐。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict


class _Display(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class FileIoDisplay(_Display):
    """读写一个文件。``path`` 是必需的，取不到就退回 ``generic``。"""

    kind: Literal["file_io"] = "file_io"
    operation: Literal["read", "write", "edit", "glob", "grep"]
    path: str


class GenericDisplay(_Display):
    """兜底：给一句话，客户端照它画一张朴素的卡。"""

    kind: Literal["generic"] = "generic"
    summary: str


_FILE_OPERATIONS: dict[str, Literal["read", "write", "edit", "glob", "grep"]] = {
    "read_file": "read",
    "write_file": "write",
    "edit_file": "edit",
    "list_files": "glob",
    "search_files": "grep",
    "ReadMediaFile": "read",
}
"""按文件操作画的那几件。``delete_file`` 不在里面：协议的 operation 联合里没有「删」。"""

_SUMMARIES: dict[str, str] = {
    "delete_file": "删掉文件",
    "video_parser_md": "拆解参考视频",
    "plan_shot_frames": "规划要出的帧",
    "generate_shot_frames": "出镜头帧",
    "generate_anchor_sheet": "出主体定妆图",
    "write_video_shots": "写镜头表",
}


def tool_display(name: str, args: Any) -> FileIoDisplay | GenericDisplay:
    """这件工具这一次调用该画成什么。

    实时那条路与历史那条路都走这一个函数：两边给出的卡不一样的话，同一张卡在刷新前后会换个
    长相，而且不报错。
    """

    operation = _FILE_OPERATIONS.get(name)
    if operation is not None and isinstance(args, dict):
        path = args.get("path")
        if isinstance(path, str) and path:
            return FileIoDisplay(operation=operation, path=path)
    return GenericDisplay(summary=_SUMMARIES.get(name, name))


__all__ = ["FileIoDisplay", "GenericDisplay", "tool_display"]
