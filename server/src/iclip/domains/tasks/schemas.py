"""创作需求单的 wire 形状，以及 brief 的类型。

**brief 只有一套定义。** 它既是 HTTP 进得来的形状，也是入库的形状：字段有哪些、时长
取值范围多大、参考素材最多几条，全在这里由 pydantic 判一次，不再另写一份手工校验。
落库存 ``model_dump(by_alias=True)``（camelCase），读回来用 ``brief_from_payload``
重新校验一遍——库里的行可能是上一个版本的进程写的，形状坏了要响亮失败，不降级。

字段名对外一律 camelCase（见仓库根的 contract/conventions.md §3）。
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Annotated, Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel

from iclip.common.errors import ValidationFailed

if TYPE_CHECKING:  # 只为类型：真导入会和 models.py 成环
    from iclip.domains.tasks.models import Task

MAX_TITLE_CHARS: Final = 200
MAX_SHORT_TEXT_CHARS: Final = 200
MAX_DESCRIPTION_CHARS: Final = 4000
MAX_REFERENCE_URLS: Final = 16
MIN_DURATION_SECONDS: Final = 3
MAX_DURATION_SECONDS: Final = 50
DEFAULT_LIST_LIMIT: Final = 20
MAX_LIST_LIMIT: Final = 100

TaskRatio = Literal["1:1", "3:4", "4:3", "9:16", "16:9", "21:9"]
"""需求方期望的画幅。这是需求单上的一句要求，不是某家生成接口的参数——所以它在这里
自己定义一份，不去引用生成域的取值表（两者本来就可以各自演进）。"""


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


ShortText = Annotated[str, Field(max_length=MAX_SHORT_TEXT_CHARS)]
Description = Annotated[str, Field(max_length=MAX_DESCRIPTION_CHARS)]
ReferenceUrls = Annotated[list[str], Field(max_length=MAX_REFERENCE_URLS)]


def _http_only(urls: list[str]) -> list[str]:
    """参考素材只收 http(s)。

    这些地址会被下游拿去下载（模型读参考图、拆解参考视频），放行 ``file://`` 之类的
    scheme 等于把服务端变成任意文件的读取入口。
    """

    for index, url in enumerate(urls):
        if not url.startswith(("http://", "https://")):
            raise ValueError(f"[{index}] 必须是 http:// 或 https:// 地址")
    return urls


class TaskBrief(CamelModel):
    """一份需求单上的创作输入。

    每一项都可以先空着——需求方通常是分几次填完的，草稿阶段不催。发布时才要求它至少
    说清楚要做什么（见 ``service.py`` 的发布关卡）。
    """

    theme: ShortText = ""
    purpose: ShortText = ""
    audience: ShortText = ""
    selling: ShortText = ""
    scene: ShortText = ""
    department: ShortText = ""
    video_type: ShortText = ""
    color: ShortText = ""
    content_type: ShortText = ""
    requester: ShortText = ""
    requirement_description: Description = ""

    duration_seconds: Annotated[
        int | None, Field(ge=MIN_DURATION_SECONDS, le=MAX_DURATION_SECONDS)
    ] = None
    ratio: TaskRatio | None = None
    language: ShortText = ""
    platform: ShortText = ""

    reference_images: ReferenceUrls = Field(default_factory=list)
    reference_videos: ReferenceUrls = Field(default_factory=list)

    _check_images = field_validator("reference_images")(_http_only)
    _check_videos = field_validator("reference_videos")(_http_only)


EMPTY_BRIEF: Final = TaskBrief()

PLANNER_FIELDS: Final = frozenset(
    {
        "duration_seconds",
        "ratio",
        "requirement_description",
        "reference_images",
        "reference_videos",
    }
)
"""发布之后仍然可以改的 brief 字段。

需求单一旦下发，需求方写下的创作输入就冻结了——接单的人是照着它开工的，改了等于让
两边看到的需求不一样。留这几项能改，是因为它们是接单之后才补得出来的：从参考视频里
量出的时长与画幅、整理过的参考素材、以及把口头需求落成文字的那段描述。
"""


def brief_to_payload(brief: TaskBrief) -> dict[str, Any]:
    """入库形状：camelCase，与 wire 完全一致。"""

    return brief.model_dump(by_alias=True)


def brief_from_payload(payload: dict[str, Any]) -> TaskBrief:
    """从库里读回来的 brief 重新校验一遍；形状坏了响亮失败，不降级成空 brief。"""

    try:
        return TaskBrief.model_validate(payload)
    except Exception as exc:
        raise ValidationFailed(f"需求单的 brief 形状非法：{exc}") from exc


class TaskIn(CamelModel):
    """建一张需求单，或整体覆盖一张已有的。

    创建与更新用同一个形状：更新就是整体覆盖（PUT），不做字段级的局部合并——局部合并
    在「哪些字段发布后冻结」这种规则面前很难说清楚「没传」到底是不改还是清空。
    """

    title: Annotated[str, Field(min_length=1, max_length=MAX_TITLE_CHARS)]
    priority: Annotated[int, Field(ge=0, le=100)] = 0
    deadline: datetime | None = None
    brief: TaskBrief = EMPTY_BRIEF


class TaskOut(CamelModel):
    id: uuid.UUID
    title: str
    status: str
    priority: int
    deadline: datetime | None
    creator_user_id: uuid.UUID
    """谁提的这张需求单。需求单是大家都看得见的工作队列，所以这一项对外可见——
    客户端也要靠它判断当前这个人能不能改草稿。"""
    brief: TaskBrief
    created_at: datetime
    updated_at: datetime


class TaskEnvelope(CamelModel):
    task: TaskOut


class TasksPageOut(CamelModel):
    items: list[TaskOut]


def task_out(task: Task) -> TaskOut:
    """领域行 → wire 形状。"""

    return TaskOut(
        id=task.id,
        title=task.title,
        status=task.status,
        priority=task.priority,
        deadline=task.deadline,
        creator_user_id=task.creator_user_id,
        brief=task.brief,
        created_at=task.created_at,
        updated_at=task.updated_at,
    )


__all__ = [
    "DEFAULT_LIST_LIMIT",
    "EMPTY_BRIEF",
    "MAX_DESCRIPTION_CHARS",
    "MAX_DURATION_SECONDS",
    "MAX_LIST_LIMIT",
    "MAX_REFERENCE_URLS",
    "MAX_SHORT_TEXT_CHARS",
    "MAX_TITLE_CHARS",
    "MIN_DURATION_SECONDS",
    "PLANNER_FIELDS",
    "TaskBrief",
    "TaskEnvelope",
    "TaskIn",
    "TaskOut",
    "TaskRatio",
    "TasksPageOut",
    "brief_from_payload",
    "brief_to_payload",
    "task_out",
]
