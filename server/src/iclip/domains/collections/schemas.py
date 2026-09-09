"""合集的 wire 形状。字段名按跨端约定用 camelCase。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Final

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from iclip.domains.collections.models import Collection

MAX_NAME_CHARS: Final = 200
MAX_LIST_LIMIT: Final = 100


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


Name = Annotated[str, Field(min_length=1, max_length=MAX_NAME_CHARS)]


class CollectionIn(CamelModel):
    """新建或改名。名字必填——没名字的口袋没法认。"""

    name: Name


class CollectionOut(CamelModel):
    id: uuid.UUID
    owner_user_id: uuid.UUID
    """外发：治理者的全量视图要显示这个口袋是谁的。"""
    name: str
    created_at: datetime
    updated_at: datetime


class CollectionEnvelope(CamelModel):
    collection: CollectionOut


class CollectionsPageOut(CamelModel):
    items: list[CollectionOut]


def collection_out(collection: Collection) -> CollectionOut:
    """领域行 → wire 形状。"""

    return CollectionOut(
        id=collection.id,
        owner_user_id=collection.owner_user_id,
        name=collection.name,
        created_at=collection.created_at,
        updated_at=collection.updated_at,
    )


__all__ = [
    "MAX_LIST_LIMIT",
    "MAX_NAME_CHARS",
    "CollectionEnvelope",
    "CollectionIn",
    "CollectionOut",
    "CollectionsPageOut",
    "collection_out",
]
