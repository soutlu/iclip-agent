"""项目的 wire 形状。字段名按跨端约定用 camelCase。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Final

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from iclip.domains.projects.models import Project

MAX_NAME_CHARS: Final = 200
MAX_LIST_LIMIT: Final = 100


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


Name = Annotated[str, Field(min_length=1, max_length=MAX_NAME_CHARS)]


class ProjectIn(CamelModel):
    """新建或改名。名字必填——没名字的口袋没法认。"""

    name: Name


class ProjectOut(CamelModel):
    id: uuid.UUID
    creator_user_id: uuid.UUID
    """外发：项目全公司可见，界面要显示这摊活是谁开的。"""
    name: str
    created_at: datetime
    updated_at: datetime


class ProjectEnvelope(CamelModel):
    project: ProjectOut


class ProjectsPageOut(CamelModel):
    items: list[ProjectOut]


def project_out(project: Project) -> ProjectOut:
    """领域行 → wire 形状。"""

    return ProjectOut(
        id=project.id,
        creator_user_id=project.creator_user_id,
        name=project.name,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


__all__ = [
    "MAX_LIST_LIMIT",
    "MAX_NAME_CHARS",
    "ProjectEnvelope",
    "ProjectIn",
    "ProjectOut",
    "ProjectsPageOut",
    "project_out",
]
