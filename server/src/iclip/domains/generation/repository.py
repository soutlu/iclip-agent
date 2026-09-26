"""生成任务持久化端口。提供按状态更新的方法，避免读取后整体覆盖导致并发丢失。
排期由 procrastinate 管理，仓储仅记录业务事实。"""

from __future__ import annotations

import uuid
from collections.abc import Collection, Mapping, Sequence
from typing import Any, Protocol

from iclip.domains.generation.models import (
    GenerationJob,
    GenerationKind,
    GenerationOperation,
    GenerationStatus,
    InFlightPhase,
    Inheritance,
)


class GenerationRepository(Protocol):
    """``generation_jobs`` 的数据访问。"""

    async def create(self, job: GenerationJob) -> GenerationJob:
        """插入一行新 job。"""
        ...

    async def create_settled(self, jobs: Sequence[GenerationJob]) -> tuple[GenerationJob, ...]:
        """一个事务里插入几行创建即完成的记录（切图、上传），产物地址照 job 写，建立与完成时刻都取
        数据库时钟。同 id 已存在就跳过、不覆盖，返回值里没有它；返回真正插进去的，与输入同序。"""
        ...

    async def find_image_by_output(
        self,
        output_url: str,
        *,
        owner: uuid.UUID | None,
        conversation_id: uuid.UUID | None,
        inherited: Inheritance = (),
        operation: GenerationOperation | None = None,
    ) -> GenerationJob | None:
        """产物地址就是 ``output_url`` 的一张已完成的图片；给了 ``operation`` 就只找那一种。

        范围与按对话列记录相同：按属主收敛、在 ``conversation_id`` 那段对话里的（为空就是没有对话的），
        并上经 ``inherited`` 继承来的。对上多条取最早建立的那条；一条都没有给 ``None``。"""
        ...

    async def output_urls(self, ids: Collection[uuid.UUID]) -> Mapping[uuid.UUID, str]:
        """这几条记录的产物地址，没有产物的不在结果里。不按属主过滤：只给已经可见的行找来源地址。"""
        ...

    async def get(
        self, job_id: uuid.UUID, *, owner: uuid.UUID | None, inherited: Inheritance = ()
    ) -> GenerationJob:
        """读取可见任务；owner=None 取消属主过滤，不可见时抛 NotFound。

        ``inherited`` 给了，经这组边界对继承来的记录不看属主也读得到（规则见 ``Inheritance``）。"""
        ...

    async def list_for_owner(
        self,
        *,
        owner: uuid.UUID | None,
        limit: int,
        conversation_id: uuid.UUID | None = None,
        kind: GenerationKind | None = None,
        operation: GenerationOperation | None = None,
        metadata: Mapping[str, Any] | None = None,
        task_id: uuid.UUID | None = None,
        shot_index: int | None = None,
        root_job_id: uuid.UUID | None = None,
        source_job_id: uuid.UUID | None = None,
        before: uuid.UUID | None = None,
        inherited: Inheritance = (),
    ) -> tuple[GenerationJob, ...]:
        """按创建时间倒序列出；``conversation_id`` / ``task_id`` 给了就只要那段对话、那张需求单下面的，
        ``shot_index`` 给了就只要那个镜号的，``root_job_id`` / ``source_job_id`` 给了就只要以那条为
        原作、为直接来源的，``kind`` / ``operation`` 给了就只要那一种，``metadata`` 给了就只要坐标
        包含这些键值的（JSONB ``@>``）。

        ``inherited`` 是 ``conversation_id`` 那段对话的继承边界对：按属主收敛的那段对话自己的记录
        之外，再并上经它继承来的记录（不看属主）；其余筛选与 ``before`` 锚点对两者一视同仁。"""
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
        watermark_output_url: str | None = None,
        duration_ms: int | None = None,
        only_if_status: GenerationStatus | None = None,
    ) -> GenerationJob | None:
        """记录成功终态。同步生成在此保存回执 id，并补齐尚未写入的 submitted_at；给了 ``duration_ms``
        就记下产物时长。

        指定 only_if_status 时原子校验状态，不匹配返回 None，避免覆盖并发写入的结果。"""
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
        provider_snapshot: dict[str, Any] | None = None,
        only_if_status: GenerationStatus | None = None,
    ) -> GenerationJob | None:
        """保存本次 Provider 状态；后续查询时间由队列管理。

        省略 snapshot 时不动原快照——它整份覆盖写，本地加工上报阶段时带上会把完成时那次写打掉。
        指定 only_if_status 时原子校验状态，不匹配返回 None，表示这条已经不在预期状态上。"""
        ...

    async def record_reference_cut(
        self,
        job_id: uuid.UUID,
        *,
        range_start_ms: int,
        range_end_ms: int,
        only_if_status: GenerationStatus,
    ) -> GenerationJob | None:
        """编辑段的参考片段切好了：区间改记实际切点，阶段词清空，业务状态不变、不算一跳。

        原子校验 ``only_if_status``，不匹配返回 None，表示这一行已有结论，调用方不该再交上游。"""
        ...

    async def in_flight_by_conversation(
        self, conversation_ids: Sequence[uuid.UUID], *, kind: GenerationKind
    ) -> Mapping[uuid.UUID, InFlightPhase]:
        """这些对话下还没跑完的某类任务各到哪一步；一条都没有的对话不在结果里。不按属主过滤，
        调用方给的对话本来就是它能看的。"""
        ...


__all__ = ["GenerationRepository"]
