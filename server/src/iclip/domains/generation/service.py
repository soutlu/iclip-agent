"""媒体生成用例。受理请求时校验、保存 pending 记录并排队，Provider 调用由后台执行。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import structlog

from iclip.common.errors import ValidationFailed
from iclip.domains.generation.models import STATUS_PENDING, GenerationJob
from iclip.domains.generation.queue import GenerationQueue
from iclip.domains.generation.repository import GenerationRepository
from iclip.domains.generation.schemas import (
    KIND_IMAGE,
    KIND_VIDEO,
    GenerationRequest,
)
from iclip.domains.identity.public import Principal

_logger = structlog.stdlib.get_logger(__name__)

MAX_LIST_LIMIT = 100


class GenerationService:
    """生成请求受理与记录查询。"""

    def __init__(
        self,
        repo: GenerationRepository,
        queue: GenerationQueue,
        *,
        video_provider_name: str,
        image_provider_name: str,
    ) -> None:
        """持久化装配期确定的 Provider 名称，保留历史来源；此层不持有或调用 Provider 实例。"""

        self._repo = repo
        self._queue = queue
        self._provider_names = {
            KIND_VIDEO: video_provider_name,
            KIND_IMAGE: image_provider_name,
        }

    async def submit(self, principal: Principal, request: GenerationRequest) -> GenerationJob:
        """保存 pending 记录并排队。入库与排队分属不同事务，排队失败时标记失败并抛出错误。

        两步之间进程中断会留下未排队的 pending 记录，需要人工确认后重新发起。"""

        kind = request.kind
        now = datetime.now(UTC)
        job = GenerationJob(
            id=uuid.uuid4(),
            owner_user_id=principal.user_id,
            api_key_id=principal.api_key_id,
            conversation_id=request.conversation_id,
            shot_index=request.shot_index,
            kind=kind,
            provider=self._provider_names[kind],
            request=request,
            status=STATUS_PENDING,
            provider_task_id=None,
            provider_status=None,
            provider_snapshot=None,
            output_url=None,
            error_code=None,
            error_message=None,
            # 仓储使用数据库 now() 覆盖时间占位值。
            created_at=now,
            updated_at=now,
            submitted_at=None,
            finished_at=None,
        )
        created = await self._repo.create(job)
        try:
            await self._queue.enqueue_submit(created)
        except Exception as exc:
            await self._repo.mark_failed(
                created.id,
                error_code="QUEUE_DEFER_FAILED",
                error_message=f"受理了但没能排进队列，请重新发起：{exc}",
            )
            _logger.exception("生成任务排队失败", job_id=created.id)
            raise
        return created

    async def get(self, principal: Principal, job_id: uuid.UUID) -> GenerationJob:
        """读取可见生成记录，不可见时返回 NotFound。"""

        return await self._repo.get(job_id, owner=_owner_scope(principal))

    async def list_recent(
        self,
        principal: Principal,
        *,
        limit: int = 20,
        conversation_id: uuid.UUID | None = None,
    ) -> tuple[GenerationJob, ...]:
        """按时间倒序返回可见记录；conversation_id 仅用于筛选，不扩大属主可见范围。"""

        if not 1 <= limit <= MAX_LIST_LIMIT:
            raise ValidationFailed(f"limit 必须在 1 到 {MAX_LIST_LIMIT} 之间")
        return await self._repo.list_for_owner(
            owner=_owner_scope(principal), limit=limit, conversation_id=conversation_id
        )


def _owner_scope(principal: Principal) -> uuid.UUID | None:
    """治理者（``users:manage``）看全部，其余人只看自己的。"""

    if principal.has("users:manage"):
        return None
    return principal.user_id


__all__ = ["MAX_LIST_LIMIT", "GenerationService"]
