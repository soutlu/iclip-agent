"""``iclip.generation_jobs`` 的 Postgres 后端。DDL 归 Alembic，这里不建表。

**这张表只存事实，不存排期。** 「下一个该做谁、几点做」在 procrastinate 自己的表里
（见 ``queue.py``）；这里只回答「这次生成是谁发起的、发给了谁、现在到哪一步了、结果
是什么」。清空 procrastinate 的表只会丢掉排期，不会丢掉任何一次生成的事实。

**所有时刻都取数据库的时钟**（``now()``），一个都不从应用进程取。多台应用服务器的
时钟差几秒，「这次生成花了多久」「谁先写的」就都对不上了，而这些是要拿去对账的。
"""

from __future__ import annotations

import uuid
from typing import Any, Final

from sqlalchemy import (
    Column,
    DateTime,
    ForeignKey,
    Index,
    MetaData,
    Table,
    Text,
    Uuid,
    func,
    select,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine.row import RowMapping
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.common.errors import NotFound
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_SUBMITTED,
    STATUS_SUBMITTING,
    GenerationJob,
    GenerationKind,
    GenerationStatus,
)
from iclip.domains.generation.schemas import request_from_payload, request_to_payload
from iclip.platform.db.ownership import scope_to_owner

DB_SCHEMA: Final = "iclip"

metadata_obj = MetaData(schema=DB_SCHEMA)

generation_jobs_table = Table(
    "generation_jobs",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    Column(
        "owner_user_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.users.id", ondelete="cascade"),
        nullable=False,
    ),
    # 故意不建到 api_keys 的外键：key 行随属主级联删除，而「哪把 key 干的」这条
    # 审计事实必须比那把 key 活得更久。
    Column("api_key_id", Uuid, nullable=True),
    Column("kind", Text, nullable=False),
    Column("provider", Text, nullable=False),
    Column("request", JSONB, nullable=False),
    Column("status", Text, nullable=False),
    Column("provider_task_id", Text, nullable=True),
    Column("provider_status", Text, nullable=True),
    Column("provider_snapshot", JSONB, nullable=True),
    Column("output_url", Text, nullable=True),
    Column("error_code", Text, nullable=True),
    Column("error_message", Text, nullable=True),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    Column("submitted_at", DateTime(timezone=True), nullable=True),
    Column("finished_at", DateTime(timezone=True), nullable=True),
    # 列表页：某个人的，按时间倒序。
    Index("ix_generation_jobs_owner_created", "owner_user_id", "created_at"),
)

_JOBS = generation_jobs_table.c


class SqlGenerationRepository:
    """``GenerationRepository`` 的 Postgres 实现。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def create(self, job: GenerationJob) -> GenerationJob:
        async with self._engine.begin() as conn:
            row = (
                (
                    await conn.execute(
                        generation_jobs_table.insert()
                        .values(
                            id=job.id,
                            owner_user_id=job.owner_user_id,
                            api_key_id=job.api_key_id,
                            kind=job.kind,
                            provider=job.provider,
                            request=request_to_payload(job.request),
                            status=job.status,
                            provider_task_id=None,
                            provider_status=None,
                            provider_snapshot=None,
                            output_url=None,
                            error_code=None,
                            error_message=None,
                            created_at=func.now(),
                            updated_at=func.now(),
                            submitted_at=None,
                            finished_at=None,
                        )
                        .returning(generation_jobs_table)
                    )
                )
                .mappings()
                .one()
            )
        return _job_from_row(row)

    async def get(self, job_id: uuid.UUID, *, owner: uuid.UUID | None) -> GenerationJob:
        stmt = scope_to_owner(
            select(generation_jobs_table).where(_JOBS.id == job_id),
            _JOBS.owner_user_id,
            owner,
        )
        async with self._engine.connect() as conn:
            row = (await conn.execute(stmt)).mappings().one_or_none()
        if row is None:
            raise NotFound(f"没有这次生成: {job_id}")
        return _job_from_row(row)

    async def list_for_owner(
        self, *, owner: uuid.UUID | None, limit: int
    ) -> tuple[GenerationJob, ...]:
        stmt = scope_to_owner(select(generation_jobs_table), _JOBS.owner_user_id, owner).order_by(
            _JOBS.created_at.desc(), _JOBS.id.desc()
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(stmt.limit(limit))).mappings().all()
        return tuple(_job_from_row(row) for row in rows)

    async def mark_submitting(self, job_id: uuid.UUID) -> GenerationJob:
        return await self._update(job_id, status=STATUS_SUBMITTING, updated_at=func.now())

    async def mark_submitted(
        self,
        job_id: uuid.UUID,
        *,
        provider_task_id: str,
        provider_status: str,
        provider_snapshot: dict[str, Any],
    ) -> GenerationJob:
        return await self._update(
            job_id,
            status=STATUS_SUBMITTED,
            provider_task_id=provider_task_id,
            provider_status=provider_status,
            provider_snapshot=provider_snapshot,
            submitted_at=func.now(),
            updated_at=func.now(),
        )

    async def mark_completed(
        self,
        job_id: uuid.UUID,
        *,
        output_url: str,
        provider_status: str,
        provider_snapshot: dict[str, Any],
        provider_task_id: str | None = None,
    ) -> GenerationJob:
        values: dict[str, Any] = {
            "status": STATUS_COMPLETED,
            "output_url": output_url,
            "provider_status": provider_status,
            "provider_snapshot": provider_snapshot,
            # 同步接口一步到底，submitted_at 还没人填过；已经填过的（视频那条路）
            # 保持原值，别把「发出去的时刻」改成「拿到结果的时刻」。
            "submitted_at": func.coalesce(_JOBS.submitted_at, func.now()),
            "finished_at": func.now(),
            "updated_at": func.now(),
        }
        if provider_task_id is not None:
            values["provider_task_id"] = provider_task_id
        return await self._update(job_id, **values)

    async def mark_failed(
        self,
        job_id: uuid.UUID,
        *,
        error_code: str,
        error_message: str,
        provider_status: str | None = None,
        provider_snapshot: dict[str, Any] | None = None,
        only_if_status: GenerationStatus | None = None,
    ) -> GenerationJob | None:
        values: dict[str, Any] = {
            "status": STATUS_FAILED,
            "error_code": error_code,
            "error_message": error_message,
            "finished_at": func.now(),
            "updated_at": func.now(),
        }
        if provider_status is not None:
            values["provider_status"] = provider_status
        if provider_snapshot is not None:
            values["provider_snapshot"] = provider_snapshot
        if only_if_status is not None:
            return await self._update_if(job_id, only_if_status, **values)
        return await self._update(job_id, **values)

    async def record_progress(
        self,
        job_id: uuid.UUID,
        *,
        provider_status: str,
        provider_snapshot: dict[str, Any],
    ) -> GenerationJob:
        return await self._update(
            job_id,
            provider_status=provider_status,
            provider_snapshot=provider_snapshot,
            updated_at=func.now(),
        )

    async def _update_if(
        self, job_id: uuid.UUID, expected: GenerationStatus, **values: Any
    ) -> GenerationJob | None:
        """带状态守卫的更新：状态已经不是 ``expected`` 就一行都不动。

        守卫塞进 ``WHERE`` 而不是先读后写：这是两个 worker 抢同一行的当口，先读后写
        中间的那道缝正是要关掉的东西。
        """

        async with self._engine.begin() as conn:
            row = (
                (
                    await conn.execute(
                        generation_jobs_table.update()
                        .where(_JOBS.id == job_id, _JOBS.status == expected)
                        .values(**values)
                        .returning(generation_jobs_table)
                    )
                )
                .mappings()
                .one_or_none()
            )
        return None if row is None else _job_from_row(row)

    async def _update(self, job_id: uuid.UUID, **values: Any) -> GenerationJob:
        async with self._engine.begin() as conn:
            row = (
                (
                    await conn.execute(
                        generation_jobs_table.update()
                        .where(_JOBS.id == job_id)
                        .values(**values)
                        .returning(generation_jobs_table)
                    )
                )
                .mappings()
                .one_or_none()
            )
        if row is None:
            raise NotFound(f"没有这次生成: {job_id}")
        return _job_from_row(row)


def _job_from_row(row: RowMapping) -> GenerationJob:
    kind: GenerationKind = row["kind"]
    status: GenerationStatus = row["status"]
    return GenerationJob(
        id=row["id"],
        owner_user_id=row["owner_user_id"],
        api_key_id=row["api_key_id"],
        kind=kind,
        provider=row["provider"],
        request=request_from_payload(kind, row["request"]),
        status=status,
        provider_task_id=row["provider_task_id"],
        provider_status=row["provider_status"],
        provider_snapshot=row["provider_snapshot"],
        output_url=row["output_url"],
        error_code=row["error_code"],
        error_message=row["error_message"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        submitted_at=row["submitted_at"],
        finished_at=row["finished_at"],
    )


__all__ = [
    "DB_SCHEMA",
    "SqlGenerationRepository",
    "generation_jobs_table",
    "metadata_obj",
]
