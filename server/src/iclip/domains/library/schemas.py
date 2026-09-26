"""资料库的读模型：一张卡是一段对话的分镜，脚本取自出片那一刻的请求。直接就是三个端点的响应，
camelCase 别名。

术语与收录口径见 docs/CONTEXT.md「资料库」。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class ScriptCutOut(CamelModel):
    """一镜：起止秒、正文、正文里引用的参考图编号（``@ImageN`` 的 N，按首次出现顺序）。"""

    start: float
    end: float
    prompt: str
    image_indexes: list[int]


class ScriptOut(CamelModel):
    """结构化的镜头组：全局设定加逐镜时间线。"""

    global_settings: str
    timeline: list[ScriptCutOut]


class TakeOut(CamelModel):
    """一版成片对应的出片：参数与脚本照出片那一刻的请求。合成沿原作取，原作可以在祖先对话里。"""

    id: uuid.UUID
    model: str | None
    aspect_ratio: str | None
    seconds: int | None
    resolution: str | None
    generate_audio: bool | None
    prompt: str
    """发给模型的原文，复制就给它。"""
    script: ScriptOut | None
    """镜头组：请求里带结构化的就用它，否则按拼装规则从原文拆；拆不出来是 ``None``，即纯文本。"""
    reference_image_urls: list[str]


class FaceOut(CamelModel):
    """一版成片的版本头：卡面放的那一版，也是详情里每一版的公共部分。"""

    kind: Literal["take", "composite"]
    """``take`` 是出片，``composite`` 是合成。"""
    job_id: uuid.UUID
    output_url: str
    watermark_output_url: str | None
    """合成是本系统拼的，没有水印版，恒为 ``None``。"""
    duration_ms: int | None
    """量出来的时长，只有合成有。"""
    finished_at: datetime
    """完成时刻。卡面的完成时刻决定列表顺序与时间筛选，组内按它编版本。"""
    user_name: str | None
    """这一版属主的用户名；账号没有用户名时为 ``None``。"""


class VersionOut(FaceOut):
    """详情里的一版：版本头加它对应的出片。"""

    take: TakeOut


class ShotGroupOut(CamelModel):
    """卡里的一个镜头组：有镜号的按镜号成组；没有镜号的是一条出片连同同原作的合成。"""

    shot_index: int | None
    versions: list[VersionOut]
    """早完成的在前，第 N 条就是第 N 版。"""


class LibraryVideoOut(CamelModel):
    """资料库的一张卡：一段对话的分镜，装着这段对话读得到的全部成片（自己的加继承来的）；
    不挂对话的出片一条一张卡，同原作的合成跟着它。"""

    id: uuid.UUID
    """卡 id：对话 id；不挂对话的卡是那条出片的 id。详情按它取。"""
    conversation_id: uuid.UUID | None
    """来源对话，对所有读者都给；不挂对话为 ``None``。"""
    can_open_conversation: bool
    """这位读者能不能打开来源对话，口径同对话的可读范围（治理者含墓碑）；不挂对话恒为 ``False``。"""
    title: str | None
    """来源对话的标题，对话删了照给；不挂对话为 ``None``。"""
    agent_id: str | None
    task_id: uuid.UUID | None
    user_name: str | None
    """卡的作者：对话属主的用户名，不挂对话的是出片属主的；账号没有用户名时为 ``None``。"""
    group_count: int
    """卡里有几个镜头组，含继承来的。"""
    version_count: int
    """卡里一共几版成片，各组相加，含继承来的。"""
    face: FaceOut
    """卡面：对话自己最新的成片。"""
    take: TakeOut
    """卡面那一版对应的出片。"""


class LibraryVideosOut(CamelModel):
    items: list[LibraryVideoOut]
    next_cursor: str | None
    total: int | None
    """当前筛选下一共几张卡；只有第一页（不带 ``cursor``）给，翻页时为 ``None``。"""


class LibraryVideoDetailOut(CamelModel):
    video: LibraryVideoOut
    groups: list[ShotGroupOut]
    """有镜号的组按镜号从小到大在前；没镜号的组在后，按出片完成先后。"""


class LibraryAuthorOut(CamelModel):
    user_name: str
    count: int
    """这个人作者的卡有几张。"""


class LibraryAuthorsOut(CamelModel):
    items: list[LibraryAuthorOut]


__all__ = [
    "FaceOut",
    "LibraryAuthorOut",
    "LibraryAuthorsOut",
    "LibraryVideoDetailOut",
    "LibraryVideoOut",
    "LibraryVideosOut",
    "ScriptCutOut",
    "ScriptOut",
    "ShotGroupOut",
    "TakeOut",
    "VersionOut",
]
