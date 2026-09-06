"""需求单 HTTP 模型与 inputs JSONB 的统一类型定义。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Annotated, Any, Final, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from pydantic.alias_generators import to_camel

from iclip.common.errors import ValidationFailed

if TYPE_CHECKING:  # 只为类型：真导入会和 models.py 成环
    from iclip.domains.tasks.models import Task

MAX_TITLE_CHARS: Final = 200
MAX_SHORT_TEXT_CHARS: Final = 200
MAX_DESCRIPTION_CHARS: Final = 4000
MAX_REFERENCE_URLS: Final = 16
MAX_STYLE_NO_CHARS: Final = 64
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
StyleNo = Annotated[str, Field(min_length=1, max_length=MAX_STYLE_NO_CHARS)]


def _http_only(urls: list[str]) -> list[str]:
    """素材地址只允许具有主机名的 HTTP(S) URL。"""

    for index, url in enumerate(urls):
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError(f"[{index}] 必须是 http:// 或 https:// 地址")
    return urls


class InputsModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid", frozen=True, json_schema_serialization_defaults_required=True
    )


class TaskVideoSpec(InputsModel):
    """视频创作规格；草稿允许尚未确定的参数留空。"""

    platform: ShortText = ""
    video_type: ShortText = ""
    content_type: ShortText = ""
    resolution: ShortText = ""
    aspect_ratio: TaskRatio | None = None
    duration_seconds: Annotated[
        int | None, Field(ge=MIN_DURATION_SECONDS, le=MAX_DURATION_SECONDS)
    ] = None


class TaskProduct(InputsModel):
    """需求单的商品快照，由调用方明确提供名称和素材。"""

    style_no: StyleNo
    name: ShortText = ""
    image_oss_urls: ReferenceUrls = Field(default_factory=list)

    _check_images = field_validator("image_oss_urls")(_http_only)

    @field_validator("style_no")
    @classmethod
    def nonblank_style_no(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("商品款号不能为空")
        return value


class TaskReferenceImages(InputsModel):
    """按用途分类的参考图片，不推断素材所属类别。"""

    model: ReferenceUrls = Field(default_factory=list)
    outfit: ReferenceUrls = Field(default_factory=list)
    prop: ReferenceUrls = Field(default_factory=list)

    _check_images = field_validator("model", "outfit", "prop")(_http_only)


class TaskInputs(InputsModel):
    """唯一的创作需求结构，HTTP 与 JSONB 均使用 snake_case。"""

    video_spec: TaskVideoSpec = Field(default_factory=TaskVideoSpec)
    product: TaskProduct
    reference_image_oss_urls: TaskReferenceImages = Field(default_factory=TaskReferenceImages)
    reference_video_oss_url: str | None = None
    creative_requirement: Description = ""

    @field_validator("reference_video_oss_url")
    @classmethod
    def check_video(cls, value: str | None) -> str | None:
        if value is not None:
            _http_only([value])
        return value


def inputs_to_payload(inputs: TaskInputs) -> dict[str, Any]:
    """序列化唯一的持久化结构。"""

    return inputs.model_dump()


def inputs_from_payload(payload: dict[str, Any]) -> TaskInputs:
    """读取时校验 JSONB，非法持久化数据直接报错。"""

    try:
        return TaskInputs.model_validate(payload)
    except ValidationError as exc:
        raise ValidationFailed(f"需求单的 inputs 形状非法：{exc}") from exc


class TaskIn(CamelModel):
    """建一张需求单，或整体覆盖一张已有的。

    创建与更新用同一个形状：更新就是整体覆盖（PUT），不做字段级的局部合并——局部合并
    在「哪些字段发布后冻结」这种规则面前很难说清楚「没传」到底是不改还是清空。
    """

    title: Annotated[str, Field(min_length=1, max_length=MAX_TITLE_CHARS)]
    priority: Annotated[int, Field(ge=0, le=100)] = 0
    deadline: datetime | None = None
    inputs: TaskInputs


class TaskCreateIn(TaskIn):
    """创建需求单；输入形状与整体更新一致。"""


class TaskOut(CamelModel):
    id: uuid.UUID
    title: str
    status: str
    priority: int
    deadline: datetime | None
    creator_user_id: uuid.UUID
    """谁提的这张需求单。需求单是大家都看得见的工作队列，所以这一项对外可见——
    客户端也要靠它判断当前这个人能不能改草稿。"""
    inputs: TaskInputs
    assignee_user_ids: list[uuid.UUID] = []
    """谁认领了这张单（``task_assignees`` 的 user_id 集合）。多人认领，按认领先后排。"""
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
        inputs=task.inputs,
        assignee_user_ids=list(task.assignee_user_ids),
        created_at=task.created_at,
        updated_at=task.updated_at,
    )


__all__ = [
    "DEFAULT_LIST_LIMIT",
    "MAX_DESCRIPTION_CHARS",
    "MAX_DURATION_SECONDS",
    "MAX_LIST_LIMIT",
    "MAX_REFERENCE_URLS",
    "MAX_SHORT_TEXT_CHARS",
    "MAX_STYLE_NO_CHARS",
    "MAX_TITLE_CHARS",
    "MIN_DURATION_SECONDS",
    "TaskCreateIn",
    "TaskEnvelope",
    "TaskIn",
    "TaskInputs",
    "TaskOut",
    "TaskProduct",
    "TaskRatio",
    "TaskReferenceImages",
    "TaskVideoSpec",
    "TasksPageOut",
    "inputs_from_payload",
    "inputs_to_payload",
    "task_out",
]
