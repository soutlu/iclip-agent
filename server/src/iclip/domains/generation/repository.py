"""媒体生成的持久化端口。

写入方法都以 job id 为准、返回写完之后的整行，因为调用方接着要把它发给下一步；
没有「取出来改改再存回去」的接口——那种写法在多 worker 下必然覆盖别人的更新。

**这里没有「领一批待办」的方法**：待办的排期归 procrastinate（见 ``queue.py``），
这张表只负责一次生成的事实。
"""

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
        """按 id 读一行。

        ``owner`` 为 ``None`` 即治理者视角（不按属主过滤）。不可见时抛 ``NotFound``
        而不是 ``PermissionDenied``——不泄露这个 id 存不存在。
        """
        ...

    async def list_for_owner(
        self, *, owner: uuid.UUID | None, limit: int
    ) -> tuple[GenerationJob, ...]:
        """按创建时间倒序列出。"""
        ...

    async def mark_submitting(self, job_id: uuid.UUID) -> GenerationJob:
        """标记「正要发给 provider」。

        必须在真的发出去之前落库：崩在这之后，这行会停在 ``submitting`` 上，从而
        被识别成「发没发出去不知道」，而不是被当成还没发过重投一次。
        """
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
        """终态：成功。

        ``provider_task_id`` 是给同步接口用的：它没有「先提交后轮询」两步，回执和结果
        一起回来，所以对账用的那个 id 只有在这一步才有机会落库。

        ``submitted_at`` 若还空着就在这里补上——同步接口「发出去」和「拿到结果」是同一
        个时刻，留空会让「这次生成花了多久」查不出来，也让两种生成的语义不一致。
        """
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
        """终态：失败。

        ``only_if_status`` 给出时，这一行的状态不是它就什么都不做并返回 ``None``。
        收尾一个「提交中断」的行要用它：判断和写入之间隔着一次 await，那当口原来那个
        worker 可能刚把真结果写完——没有这个守卫就会把一次已经成功、也已经付过钱的
        生成盖成失败。
        """
        ...

    async def record_progress(
        self,
        job_id: uuid.UUID,
        *,
        provider_status: str,
        provider_snapshot: dict[str, Any],
    ) -> GenerationJob:
        """还没出结果：把这次问到的东西记下来，累计一次尝试。

        「下次什么时候再问」不在这里——那是排期的事（见 ``queue.py``）。
        """
        ...


__all__ = ["GenerationRepository"]
