"""生成任务持久化端口。提供按状态更新的方法，避免读取后整体覆盖导致并发丢失。
排期由 procrastinate 管理，仓储仅记录业务事实。"""

from __future__ import annotations

import uuid
from typing import Any, Protocol

from iclip.domains.generation.models import GenerationJob, GenerationStatus


class GenerationRepository(Protocol):
    """``generation_jobs`` 的数据访问。"""

    async def create(self, job: GenerationJob) -> GenerationJob:
        """插入一行新 job。"""
        ...

    async def get(self, job_id: uuid.UUID, *, owner: uuid.UUID | None) -> GenerationJob:
        """读取可见任务；owner=None 取消属主过滤，不可见时抛 NotFound。"""
        ...

    async def list_for_owner(
        self, *, owner: uuid.UUID | None, limit: int, conversation_id: uuid.UUID | None = None
    ) -> tuple[GenerationJob, ...]:
        """按创建时间倒序列出；``conversation_id`` 给了就只要那段对话下面的。"""
        ...

    async def mark_submitting(self, job_id: uuid.UUID) -> GenerationJob:
        """在调用 Provider 前持久化 submitting，使恢复流程能识别提交结果未知的任务。"""
        ...

    async def mark_submitted(
        self,
        job_id: uuid.UUID,
        *,
        provider_task_id: str,
        provider_status: str,
        provider_snapshot: dict[str, Any],
    ) -> GenerationJob:
        """记下 provider 回执，转入等结果。"""
        ...

    async def mark_completed(
        self,
        job_id: uuid.UUID,
        *,
        output_url: str,
        provider_status: str,
        provider_snapshot: dict[str, Any],
        provider_task_id: str | None = None,
    ) -> GenerationJob:
        """记录成功终态。同步生成在此保存回执 id，并补齐尚未写入的 submitted_at。"""
        ...

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
        """记录失败终态；指定 only_if_status 时原子校验状态，不匹配返回 None，避免覆盖并发结果。"""
        ...

    async def record_progress(
        self,
        job_id: uuid.UUID,
        *,
        provider_status: str,
        provider_snapshot: dict[str, Any],
    ) -> GenerationJob:
        """保存本次 Provider 状态；后续查询时间由队列管理。"""
        ...


__all__ = ["GenerationRepository"]
