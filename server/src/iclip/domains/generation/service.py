"""媒体生成的用例层。

提交只做三件事：校验，落一行 ``pending``，把它排进队列。真的去调 provider 是后台的
事——图像那家接口一次要等几分钟，把它留在 HTTP 请求里，客户端会先超时，而那次生成
还在扣钱。
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

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

_logger = logging.getLogger(__name__)

MAX_LIST_LIMIT = 100


class GenerationService:
    """提交一次生成，以及读回自己的生成记录。"""

    def __init__(
        self,
        repo: GenerationRepository,
        queue: GenerationQueue,
        *,
        video_provider_name: str,
        image_provider_name: str,
    ) -> None:
        """provider 的名字在装配期定下来，落在 job 行上。

        只要名字不要实例：这一层不调 provider（那是后台 worker 的活），但每一行都
        得记下是谁生成的，否则换 provider 之后旧记录无从解释。
        """

        self._repo = repo
        self._queue = queue
        self._provider_names = {
            KIND_VIDEO: video_provider_name,
            KIND_IMAGE: image_provider_name,
        }

    async def submit(self, principal: Principal, request: GenerationRequest) -> GenerationJob:
        """受理一次生成，返回刚落库的 ``pending`` 行。

        **落行和排队做不到一个事务里。** 行走 asyncpg，队列走 psycopg（procrastinate
        只支持它），两个驱动就是两个事务。所以排队失败时把这一行照实判失败并把错误
        抛给调用方——留下一个「永远 pending」的行更糟：那看起来像还在排队。

        崩在两步中间会留下一个没有任务的 ``pending`` 行。罕见、看得见、由人重新发
        起，和 ``SUBMIT_INTERRUPTED`` 是同一条道理：宁可让人来决定，不替他猜。
        """

        kind = request.kind
        now = datetime.now(UTC)
        job = GenerationJob(
            id=uuid.uuid4(),
            owner_user_id=principal.user_id,
            api_key_id=principal.api_key_id,
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
            # 时刻字段在插入时由数据库改写成它自己的 now()；这里的值不会落库，
            # 只是把 dataclass 填满。
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
            _logger.exception("生成任务 %s 排队失败", created.id)
            raise
        return created

    async def get(self, principal: Principal, job_id: uuid.UUID) -> GenerationJob:
        """读一次生成；不是自己的一律当作不存在。"""

        return await self._repo.get(job_id, owner=_owner_scope(principal))

    async def list_recent(
        self, principal: Principal, *, limit: int = 20
    ) -> tuple[GenerationJob, ...]:
        """按时间倒序列出可见的生成记录。"""

        if not 1 <= limit <= MAX_LIST_LIMIT:
            raise ValidationFailed(f"limit 必须在 1 到 {MAX_LIST_LIMIT} 之间")
        return await self._repo.list_for_owner(owner=_owner_scope(principal), limit=limit)


def _owner_scope(principal: Principal) -> uuid.UUID | None:
    """治理者（``users:manage``）看全部，其余人只看自己的。"""

    if principal.has("users:manage"):
        return None
    return principal.user_id


__all__ = ["MAX_LIST_LIMIT", "GenerationService"]
