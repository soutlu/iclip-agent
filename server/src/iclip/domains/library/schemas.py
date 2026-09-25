"""资料库的读模型：一张卡是一镜，脚本取自出片那一刻的请求。直接就是三个端点的响应，camelCase 别名。

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


class MasterOut(CamelModel):
    """挂在一次出片名下的成片（视频编辑确认合成的那条）。"""

    id: uuid.UUID
    output_url: str
    duration_ms: int | None
    created_at: datetime


class TakeOut(CamelModel):
    """一次成功出片。参数与脚本照出片那一刻的请求。"""

    id: uuid.UUID
    created_at: datetime
    user_name: str | None
    """归属的人：请求里的 ``user_name``，没有就是记录属主的用户名。"""
    model: str | None
    aspect_ratio: str | None
    seconds: int | None
    resolution: str | None
    generate_audio: bool | None
    output_url: str
    watermark_output_url: str | None
    prompt: str
    """发给模型的原文，复制就给它。"""
    script: ScriptOut | None
    """镜头组：请求里带结构化的就用它，否则按拼装规则从原文拆；拆不出来是 ``None``，即纯文本。"""
    reference_image_urls: list[str]
    masters: list[MasterOut]
    """名下的成片，早的在前。"""


class FaceOut(CamelModel):
    """卡面放哪一条：这一镜最新的成片，没有成片就是最新一次出片。"""

    kind: Literal["take", "master"]
    job_id: uuid.UUID
    output_url: str
    watermark_output_url: str | None
    """成片是本系统合成的，没有水印版，恒为 ``None``。"""
    duration_ms: int | None
    created_at: datetime
    """卡面时刻：列表按它倒序，时间筛选也作用在它上面。"""


class LibraryVideoOut(CamelModel):
    """资料库的一张卡：一镜，即（对话，镜号）下的全部成功出片；没有镜号的出片一条一张。"""

    id: uuid.UUID
    """卡面那次出片的 id；详情按它取。卡面是成片时，是成片所属那次出片的 id。"""
    shot_index: int | None
    conversation_id: uuid.UUID | None
    """来源对话；只有对话属主与治理者拿得到，其余人恒为 ``None``。"""
    title: str | None
    """来源对话的标题；不挂对话的出片为 ``None``。"""
    agent_id: str | None
    task_id: uuid.UUID | None
    take_count: int
    """这一镜一共成功出过几次。"""
    face: FaceOut
    take: TakeOut
    """卡面那次出片：脚本、参数与名下的成片。"""


class LibraryVideosOut(CamelModel):
    items: list[LibraryVideoOut]
    next_cursor: str | None
    total: int | None
    """当前筛选下一共几张卡；只有第一页（不带 ``cursor``）给，翻页时为 ``None``。"""


class LibraryVideoDetailOut(CamelModel):
    video: LibraryVideoOut
    takes: list[TakeOut]
    """这一镜的全部成功出片，早的在前。"""
    siblings: list[LibraryVideoOut]
    """同一段对话的其他镜，镜号小的在前。"""


class LibraryAuthorOut(CamelModel):
    user_name: str
    count: int
    """这个人名下有几张卡。"""


class LibraryAuthorsOut(CamelModel):
    items: list[LibraryAuthorOut]


__all__ = [
    "FaceOut",
    "LibraryAuthorOut",
    "LibraryAuthorsOut",
    "LibraryVideoDetailOut",
    "LibraryVideoOut",
    "LibraryVideosOut",
    "MasterOut",
    "ScriptCutOut",
    "ScriptOut",
    "TakeOut",
]
