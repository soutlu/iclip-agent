"""埋点事件表与它的 Postgres 仓储。只追加；发生时刻统一用数据库时钟。"""

from __future__ import annotations

import uuid
from typing import Final

from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    MetaData,
    Table,
    Text,
    Uuid,
    func,
    text,
)
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.tracking.models import TrackingEvent

DB_SCHEMA: Final = "iclip"

metadata_obj = MetaData(schema=DB_SCHEMA)

tracking_events_table = Table(
    "tracking_events",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    Column("name", Text, nullable=False),
    # 生成记录从不硬删，主语可以建外键：事件必须指着一条真实存在的记录。
    Column(
        "job_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.generation_jobs.id", name="fk_tracking_events_job"),
        nullable=True,
    ),
    # 不关联对话外键，与生成记录同一做法。
    Column("conversation_id", Uuid, nullable=True),
    Column(
        "user_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.users.id", name="fk_tracking_events_user", ondelete="cascade"),
        nullable=False,
    ),
    # 不关联 api_keys 外键，保留 key 删除后的审计身份。
    Column("api_key_id", Uuid, nullable=True),
    Column("occurred_at", DateTime(timezone=True), nullable=False),
    CheckConstraint(
        "job_id IS NOT NULL OR conversation_id IS NOT NULL", name="ck_tracking_events_subject"
    ),
    Index("ix_tracking_events_job", "job_id"),
    Index("ix_tracking_events_conversation", "conversation_id", "occurred_at"),
    Index("ix_tracking_events_name", "name", "occurred_at"),
)

# 可下载的视频：成功、有地址，且是独立视频或视频编辑确认合成的成片。按表名直接查，不 import
# 生成域；'video' / 'clip' / 'completed' 镜像 KIND_VIDEO / KIND_CLIP / STATUS_COMPLETED，
# 'master' 镜像 ClipPurpose 的取值，集成测试的种子取自那些常量，生成域改词这里的用例就红。
_DOWNLOADABLE: Final = text("""
SELECT EXISTS (
    SELECT 1 FROM iclip.generation_jobs g
    WHERE g.id = :job_id AND g.status = 'completed' AND g.output_url IS NOT NULL
      AND ((g.kind = 'video' AND g.root_job_id IS NULL)
           OR (g.kind = 'clip' AND g.request->>'purpose' = 'master'))
)
""")


class SqlTrackingRepository:
    """``TrackingRepository`` 的 Postgres 实现。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def downloadable(self, job_id: uuid.UUID) -> bool:
        async with self._engine.connect() as conn:
            return bool((await conn.execute(_DOWNLOADABLE, {"job_id": job_id})).scalar_one())

    async def record(self, event: TrackingEvent) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                tracking_events_table.insert().values(
                    id=uuid.uuid4(),
                    name=event.name,
                    job_id=event.job_id,
                    conversation_id=event.conversation_id,
                    user_id=event.user_id,
                    api_key_id=event.api_key_id,
                    occurred_at=func.now(),
                )
            )


__all__ = ["DB_SCHEMA", "SqlTrackingRepository", "metadata_obj", "tracking_events_table"]
